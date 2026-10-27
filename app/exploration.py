"""Exploratory data analysis for the "Exploration des données" view.

Two parts:

* ``portfolio``: what a data scientist looks at before writing any rule
  (amount distribution, price spread per act, seasonality, daily volume,
  provider mix, concentration, age versus spend). It never reads the labels.
* ``signals``: for each scenario, the variable its rule thresholds, split into
  legitimate lines and injected fraud. This comparison is only possible
  because the fraud is synthetic and labelled; the page says so.

Everything is aggregated server-side so the browser only draws.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.catalog import ACTS, COSTLY_ACTS, DIAGNOSIS_GROUPS, PROVIDER_TYPES, SCENARIOS, diagnosis_group, is_coherent
from app.detectors import duplicates, early_claim, nomadism, price
from app.generator import N_DAYS, PERIOD_START

MONTHS_FR = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."]
SCATTER_MAX_POINTS = 1200
LORENZ_POINTS = 101


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


# ----------------------------------------------------------------- helpers
def histogram(values: np.ndarray, edges: np.ndarray) -> list[int]:
    """Counts per bin; values outside the edges go to the first or last bin."""
    clipped = np.clip(values, edges[0], np.nextafter(edges[-1], -np.inf))
    counts, _ = np.histogram(clipped, bins=edges)
    return [int(c) for c in counts]


def shares(counts: list[int]) -> list[float]:
    total = sum(counts)
    return [_r(c / total) if total else 0.0 for c in counts]


def lorenz(values: np.ndarray, points: int = LORENZ_POINTS) -> dict:
    """Lorenz curve (population share -> cumulative share of the total) and Gini index."""
    v = np.sort(np.asarray(values, dtype=float))
    n = len(v)
    if n == 0 or v.sum() <= 0:
        return {"x": [0.0, 1.0], "y": [0.0, 1.0], "gini": 0.0, "top10_share": 0.0, "n": n}
    cum = np.concatenate([[0.0], np.cumsum(v) / v.sum()])
    pop = np.linspace(0, 1, n + 1)
    grid = np.linspace(0, 1, points)
    y = np.interp(grid, pop, cum)
    gini = 1 - 2 * np.trapezoid(cum, pop)
    top10 = v[int(np.floor(0.9 * n)) :].sum() / v.sum()
    return {"x": [_r(g) for g in grid], "y": [_r(t) for t in y], "gini": _r(gini, 3), "top10_share": _r(top10, 3), "n": n}


def max_in_window(days: np.ndarray, window: int) -> int:
    """Largest number of sorted ``days`` falling in any span of ``window`` days."""
    best, lo = 0, 0
    for hi in range(len(days)):
        while days[hi] - days[lo] > window - 1:
            lo += 1
        best = max(best, hi - lo + 1)
    return best


def _two_groups(values: pd.Series, is_fraud: pd.Series, edges: np.ndarray, rule: pd.Series) -> dict:
    """Histograms of ``values`` for legitimate rows and injected fraud, plus the share
    of each group that meets the rule condition ``rule`` (a boolean series)."""
    legit = histogram(values[~is_fraud].to_numpy(dtype=float), edges)
    fraud = histogram(values[is_fraud].to_numpy(dtype=float), edges)
    return {
        "legit_rule_share": _r(rule[~is_fraud].mean(), 4) if (~is_fraud).any() else None,
        "fraud_rule_share": _r(rule[is_fraud].mean(), 4) if is_fraud.any() else None,
        "legit_counts": legit,
        "fraud_counts": fraud,
        "legit_share": shares(legit),
        "fraud_share": shares(fraud),
        "n_legit": int(sum(legit)),
        "n_fraud": int(sum(fraud)),
    }


# --------------------------------------------------------------- portfolio
def amount_distribution(claims: pd.DataFrame) -> dict:
    edges = np.geomspace(4, 1600, 25)
    counts = histogram(claims.billed_amount.to_numpy(), edges)
    q = claims.billed_amount.quantile([0.5, 0.9, 0.99]).to_numpy()
    return {
        "edges": [_r(e, 2) for e in edges],
        "counts": counts,
        "median": _r(q[0], 2),
        "p90": _r(q[1], 2),
        "p99": _r(q[2], 2),
        "share_below_50": _r((claims.billed_amount < 50).mean(), 3),
        "amount_share_top5pct_lines": _r(
            claims.billed_amount.nlargest(max(1, len(claims) // 20)).sum() / claims.billed_amount.sum(), 3
        ),
    }


def price_spread(claims: pd.DataFrame) -> list[dict]:
    rows = []
    for code, grp in claims.groupby("act_code", sort=True):
        q = grp.billed_amount.quantile([0.05, 0.25, 0.5, 0.75, 0.95]).to_numpy()
        rows.append(
            {
                "act_code": code,
                "label": ACTS[code].label,
                "n": len(grp),
                "p5": _r(q[0], 2),
                "q1": _r(q[1], 2),
                "median": _r(q[2], 2),
                "q3": _r(q[3], 2),
                "p95": _r(q[4], 2),
                "iqr_ratio": _r(q[3] / q[1], 3) if q[1] > 0 else None,
            }
        )
    return sorted(rows, key=lambda r: -r["median"])


def seasonality(claims: pd.DataFrame) -> dict:
    month = claims.service_date.dt.month
    group = claims.diagnosis_code.map(diagnosis_group)
    table = pd.crosstab(group, month).reindex(columns=range(1, 13), fill_value=0)
    out = []
    for g, label in DIAGNOSIS_GROUPS.items():
        counts = table.loc[g].to_numpy() if g in table.index else np.zeros(12)
        mean = counts.mean() or 1
        index = counts / mean * 100
        out.append(
            {
                "group": g,
                "label": label,
                "counts": [int(c) for c in counts],
                "index": [_r(v, 1) for v in index],
                "peak_month": MONTHS_FR[int(np.argmax(counts))],
                "amplitude": _r(index.max() - index.min(), 1),
            }
        )
    return {"months": MONTHS_FR, "groups": sorted(out, key=lambda r: -r["amplitude"])}


def daily_volume(claims: pd.DataFrame) -> dict:
    per_day = np.bincount(claims.day.to_numpy(), minlength=N_DAYS)[:N_DAYS]
    ma = pd.Series(per_day).rolling(7, min_periods=1).mean().to_numpy()
    dates = pd.date_range(PERIOD_START, periods=N_DAYS, freq="D").strftime("%Y-%m-%d")
    return {
        "dates": list(dates),
        "lines": [int(v) for v in per_day],
        "moving_avg_7d": [_r(v, 1) for v in ma],
        "mean": _r(per_day.mean(), 1),
        "cv": _r(per_day.std() / per_day.mean(), 3) if per_day.mean() else 0.0,
    }


def provider_mix(claims: pd.DataFrame) -> list[dict]:
    total_lines, total_amount = len(claims), claims.billed_amount.sum()
    agg = claims.groupby("provider_type").agg(lines=("line_id", "size"), amount=("billed_amount", "sum"))
    rows = [
        {
            "type": t,
            "label": PROVIDER_TYPES[t],
            "lines": int(r.lines),
            "amount": _r(r.amount, 2),
            "line_share": _r(r.lines / total_lines),
            "amount_share": _r(r.amount / total_amount),
            "mean_amount": _r(r.amount / r.lines, 2),
        }
        for t, r in agg.iterrows()
    ]
    return sorted(rows, key=lambda r: -r["amount_share"])


def concentration(claims: pd.DataFrame, members: pd.DataFrame, providers: pd.DataFrame) -> dict:
    by_provider = claims.groupby("provider_id").billed_amount.sum().reindex(providers.provider_id, fill_value=0)
    by_member = claims.groupby("member_id").billed_amount.sum().reindex(members.member_id, fill_value=0)
    return {"providers": lorenz(by_provider.to_numpy()), "members": lorenz(by_member.to_numpy())}


def age_vs_spend(claims: pd.DataFrame, members: pd.DataFrame, seed: int) -> dict:
    spend = claims.groupby("member_id").agg(amount=("billed_amount", "sum"), lines=("line_id", "size"))
    df = members.set_index("member_id").join(spend, how="inner")
    df["age"] = 2025 - df.birth_year
    rng = np.random.default_rng(seed)
    sample = df if len(df) <= SCATTER_MAX_POINTS else df.iloc[np.sort(rng.choice(len(df), SCATTER_MAX_POINTS, replace=False))]
    bands = []
    for lo in range(20, 90, 10):
        band = df[(df.age >= lo) & (df.age < lo + 10)]
        if len(band):
            bands.append(
                {
                    "band": f"{lo} à {lo + 9} ans",
                    "mid_age": lo + 5,
                    "n": len(band),
                    "median": _r(band.amount.median(), 2),
                    "q1": _r(band.amount.quantile(0.25), 2),
                    "q3": _r(band.amount.quantile(0.75), 2),
                }
            )
    corr = float(np.corrcoef(df.age, np.log(df.amount))[0, 1]) if len(df) > 2 else 0.0
    return {
        "points": [
            {"age": int(a), "amount": _r(m, 2), "lines": int(n)}
            for a, m, n in zip(sample.age, sample.amount, sample.lines, strict=True)
        ],
        "bands": bands,
        "n_members": len(df),
        "n_points": len(sample),
        "spearman_like_log_corr": _r(corr, 3),
    }


# ----------------------------------------------------------------- signals
def signal_price(claims: pd.DataFrame, refs: pd.DataFrame) -> dict:
    ratio = claims.billed_amount / refs.ref_median
    known = ratio.notna()
    edges = np.round(np.arange(-2.0, 3.01, 0.2), 2)  # log2 of the ratio: x0.25 .. x8
    data = _two_groups(np.log2(ratio[known]), claims.fraud_scenario[known] == 1, edges, ratio[known] >= price.RATIO_FLAG)
    return {
        "scenario": 1,
        "edges_log2": [float(e) for e in edges],
        "threshold_log2": float(np.log2(price.RATIO_FLAG)),
        "threshold_label": f"× {price.RATIO_FLAG:g}".replace(".", ","),
        "lines_without_reference": int((~known).sum()),
        **data,
    }


def signal_duplicates(claims: pd.DataFrame) -> dict:
    df = claims[~claims.act_code.map(lambda c: ACTS[c].repeatable)].sort_values(["member_id", "provider_id", "act_code", "day"])
    key = df.member_id + "|" + df.provider_id + "|" + df.act_code
    gap = df.day - df.day.shift(1)
    has_prev = key == key.shift(1)
    gaps = gap[has_prev]
    edges = np.arange(0, 17, 1)  # 0, 1, ..., 15 days; the last bin holds 15+
    data = _two_groups(gaps, df.fraud_scenario[has_prev] == 2, edges, gaps <= duplicates.MAX_GAP_DAYS)
    return {
        "scenario": 2,
        "edges": [int(e) for e in edges],
        "threshold": duplicates.MAX_GAP_DAYS,
        "pairs": int(has_prev.sum()),
        **data,
    }


def signal_providers(claims: pd.DataFrame) -> dict:
    watched = claims[claims.provider_type.isin(nomadism.WATCHED_TYPES)]
    first = watched.groupby(["member_id", "provider_type", "provider_id"], sort=True)["day"].min().reset_index()
    peaks = {}
    for (member, _ptype), grp in first.groupby(["member_id", "provider_type"], sort=True):
        peak = max_in_window(np.sort(grp["day"].to_numpy()), nomadism.WINDOW_DAYS)
        peaks[member] = max(peaks.get(member, 0), peak)
    s3_members = set(claims.loc[claims.fraud_scenario == 3, "member_id"])
    series = pd.Series(peaks)
    is_fraud = series.index.to_series().isin(s3_members)
    edges = np.arange(1, 9, 1)  # 1 .. 7, last bin 7+
    data = _two_groups(series, is_fraud, edges, series >= nomadism.MIN_NEW_PROVIDERS)
    return {
        "scenario": 3,
        "edges": [int(e) for e in edges],
        "threshold": nomadism.MIN_NEW_PROVIDERS,
        "window_days": nomadism.WINDOW_DAYS,
        "unit": "adhérents",
        **data,
    }


def signal_coherence(claims: pd.DataFrame) -> dict:
    coherent = np.array([is_coherent(a, d) for a, d in zip(claims.act_code, claims.diagnosis_code, strict=True)])
    s4 = (claims.fraud_scenario == 4).to_numpy()
    rows = []
    for code, act in ACTS.items():
        if act.allowed_groups is None:
            continue
        m = (claims.act_code == code).to_numpy()
        rows.append(
            {
                "act_code": code,
                "label": act.label,
                "lines": int(m.sum()),
                "incoherent_legit": int((m & ~coherent & ~s4).sum()),
                "incoherent_fraud": int((m & ~coherent & s4).sum()),
                "camouflaged_fraud": int((m & coherent & s4).sum()),
            }
        )
    rows.sort(key=lambda r: -(r["incoherent_legit"] + r["incoherent_fraud"]))
    return {
        "scenario": 4,
        "acts": rows,
        "legit_incoherent_rate": _r((~coherent & ~s4).sum() / max((~s4).sum(), 1), 4),
        "camouflaged_total": int((coherent & s4).sum()),
    }


def signal_early(claims: pd.DataFrame) -> dict:
    since = claims.day - claims.policy_start_day
    costly = claims.act_code.isin(COSTLY_ACTS) | (claims.billed_amount >= early_claim.MIN_AMOUNT)
    mask = (claims.policy_start_day >= 0) & costly & (since >= 0)
    edges = np.arange(0, 190, 7)  # weeks after the start date, last bin 26+ weeks
    data = _two_groups(since[mask], claims.fraud_scenario[mask] == 5, edges, since[mask] <= early_claim.MAX_DAYS)
    return {
        "scenario": 5,
        "edges": [int(e) for e in edges],
        "threshold": early_claim.MAX_DAYS,
        **data,
    }


# ------------------------------------------------------------------- entry
def explore(dataset, refs: pd.DataFrame) -> dict:
    claims = dataset.claims
    fraud = claims.fraud_scenario != 0
    return {
        "summary": {
            "n_claims": len(claims),
            "n_members": len(dataset.members),
            "n_providers": len(dataset.providers),
            "total_billed": _r(claims.billed_amount.sum(), 2),
            "median_amount": _r(claims.billed_amount.median(), 2),
            "members_with_claims": int(claims.member_id.nunique()),
            "lines_without_price_reference": _r(refs.ref_median.isna().mean(), 4),
            "fraud_line_share": _r(fraud.mean(), 4),
            "fraud_amount_share": _r(claims.billed_amount[fraud].sum() / claims.billed_amount.sum(), 4),
        },
        "portfolio": {
            "amounts": amount_distribution(claims),
            "price_spread": price_spread(claims),
            "seasonality": seasonality(claims),
            "daily": daily_volume(claims),
            "provider_mix": provider_mix(claims),
            "concentration": concentration(claims, dataset.members, dataset.providers),
            "age_spend": age_vs_spend(claims, dataset.members, dataset.seed),
        },
        "signals": {
            "labels": {str(k): v["label"] for k, v in SCENARIOS.items()},
            "price": signal_price(claims, refs),
            "duplicates": signal_duplicates(claims),
            "providers": signal_providers(claims),
            "coherence": signal_coherence(claims),
            "early": signal_early(claims),
        },
    }
