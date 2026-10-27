"""Unsupervised model shown ONLY as a comparison with the rules.

An Isolation Forest scores every claim line by how easy it is to isolate.
Two feature sets are compared:

* ``brutes``: what is available without any fraud knowledge (amount, act
  frequency, member age, provider volume, day of year);
* ``metier``: the signals the rules use, computed without labels (price
  ratio to the point-in-time reference, delay since the policy start,
  identical lines within a day, new providers in 14 days, act/diagnosis
  incoherence, amount).

The model is compared with the rules at the SAME workload: it flags as many
lines as the five rules together. It never sees the labels; they are only used
afterwards to score it. Trained on the whole year at once, which a real
deployment would not do (train on the past, score the present).

The rules stay the main system: the model gives a score, not a reason a
claims handler can act on.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.catalog import ACTS, SCENARIOS, is_coherent
from app.detectors import nomadism

N_TREES = 200
PR_POINTS = 60
FEATURE_LABELS = {
    "log_amount": "Montant (log)",
    "act_rarity": "Rareté de l'acte",
    "age": "Âge de l'adhérent",
    "provider_volume": "Volume du prestataire (log)",
    "day": "Jour de l'année",
    "log2_price_ratio": "Rapport au prix habituel (log2)",
    "early": "Proximité de la date d'effet",
    "same_day_twins": "Lignes identiques à un jour près",
    "new_providers_14d": "Nouveaux prestataires en 14 jours",
    "incoherent": "Acte incohérent avec le diagnostic",
}
FEATURE_SETS = {
    "brutes": ["log_amount", "act_rarity", "age", "provider_volume", "day"],
    "metier": ["log2_price_ratio", "early", "same_day_twins", "new_providers_14d", "incoherent", "log_amount"],
}


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


def _new_providers_14d(claims: pd.DataFrame) -> np.ndarray:
    """For each line of a watched type: providers of that type first used by the member in the last 14 days."""
    out = np.zeros(len(claims))
    pos = pd.Series(np.arange(len(claims)), index=claims.index)
    watched = claims[claims.provider_type.isin(nomadism.WATCHED_TYPES)]
    first = watched.groupby(["member_id", "provider_type", "provider_id"]).day.transform("min")
    for _, grp in watched.assign(first=first).groupby(["member_id", "provider_type"], sort=False):
        firsts = np.sort(grp.drop_duplicates("provider_id")["first"].to_numpy())
        days = grp.day.to_numpy()
        hi = np.searchsorted(firsts, days, side="right")
        lo = np.searchsorted(firsts, days - nomadism.WINDOW_DAYS + 1, side="left")
        out[pos[grp.index].to_numpy()] = hi - lo
    return out


def features(claims: pd.DataFrame, refs: pd.DataFrame, members: pd.DataFrame) -> pd.DataFrame:
    age = claims.member_id.map(dict(zip(members.member_id, 2025 - members.birth_year, strict=True)))
    act_freq = claims.act_code.map(claims.act_code.value_counts(normalize=True))
    prov_vol = claims.provider_id.map(claims.provider_id.value_counts())
    ratio = (claims.billed_amount / refs.ref_median).fillna(1.0)
    since = (claims.day - claims.policy_start_day).clip(lower=0)
    key = claims.member_id + "|" + claims.provider_id + "|" + claims.act_code
    ordered = claims.assign(key=key).sort_values(["key", "day"])
    gap_prev = ordered.day.diff().where(ordered.key == ordered.key.shift(1))
    gap_next = (-ordered.day.diff(-1)).where(ordered.key == ordered.key.shift(-1))
    twins = ((gap_prev <= 1).astype(int) + (gap_next <= 1).astype(int)).reindex(claims.index)
    repeatable = claims.act_code.map(lambda a: ACTS[a].repeatable)
    return pd.DataFrame(
        {
            "log_amount": np.log(claims.billed_amount),
            "act_rarity": -np.log(act_freq),
            "age": age.astype(float),
            "provider_volume": np.log(prov_vol.astype(float)),
            "day": claims.day.astype(float),
            "log2_price_ratio": np.log2(ratio),
            "early": 1 / (1 + since / 30.0),  # 1 on the start date, 0.5 after 30 days
            "same_day_twins": np.where(repeatable, 0, twins),
            "new_providers_14d": _new_providers_14d(claims),
            "incoherent": [
                0.0 if is_coherent(a, d) else 1.0 for a, d in zip(claims.act_code, claims.diagnosis_code, strict=True)
            ],
        },
        index=claims.index,
    )


def _pr_curve(score: np.ndarray, is_fraud: np.ndarray) -> list[dict]:
    order = np.argsort(-score, kind="stable")
    hits = np.cumsum(is_fraud[order])
    n_fraud = is_fraud.sum()
    ks = np.unique(np.geomspace(20, len(score), PR_POINTS).astype(int))
    return [{"k": int(k), "precision": _r(hits[k - 1] / k), "recall": _r(hits[k - 1] / n_fraud)} for k in ks]


def compare(dataset, refs: pd.DataFrame, alerts: list[dict]) -> dict:
    from sklearn.ensemble import IsolationForest  # heavy import, only in the background job

    claims = dataset.claims
    X = features(claims, refs, dataset.members)
    label = claims.fraud_scenario.to_numpy()
    is_fraud = label != 0
    line_ids = claims.line_id.to_numpy()
    rule_lines = {i for a in alerts for i in a["line_ids"]}
    budget = len(rule_lines)
    flagged_by_rules = np.isin(line_ids, list(rule_lines))

    def at_budget(mask: np.ndarray) -> dict:
        tp = int((mask & is_fraud).sum())
        per = {}
        for s in SCENARIOS:
            truth = label == s
            per[str(s)] = _r((mask & truth).sum() / truth.sum()) if truth.any() else None
        return {
            "flagged": int(mask.sum()),
            "precision": _r(tp / max(mask.sum(), 1)),
            "recall": _r(tp / is_fraud.sum()),
            "recall_by_scenario": per,
        }

    models = {}
    for name, cols in FEATURE_SETS.items():
        forest = IsolationForest(n_estimators=N_TREES, random_state=dataset.seed, n_jobs=1)
        Z = X[cols].to_numpy()
        forest.fit(Z)
        score = -forest.score_samples(Z)  # higher = more anomalous
        top = np.zeros(len(score), dtype=bool)
        top[np.argsort(-score, kind="stable")[:budget]] = True
        edges = np.quantile(score, np.linspace(0, 1, 31))
        legit_hist, _ = np.histogram(score[~is_fraud], bins=edges)
        fraud_hist, _ = np.histogram(score[is_fraud], bins=edges)
        models[name] = {
            "features": [{"key": c, "label": FEATURE_LABELS[c]} for c in cols],
            "at_budget": at_budget(top),
            "pr": _pr_curve(score, is_fraud),
            "score_hist": {
                "edges": [_r(e) for e in edges],
                "legit_share": [_r(v / max(legit_hist.sum(), 1)) for v in legit_hist],
                "fraud_share": [_r(v / max(fraud_hist.sum(), 1)) for v in fraud_hist],
            },
            "_score": score,
            "_top": top,
        }

    m = models["metier"]
    top = m["_top"]
    overlap = {
        "fraud_both": int((top & flagged_by_rules & is_fraud).sum()),
        "fraud_rules_only": int((~top & flagged_by_rules & is_fraud).sum()),
        "fraud_model_only": int((top & ~flagged_by_rules & is_fraud).sum()),
        "fraud_neither": int((~top & ~flagged_by_rules & is_fraud).sum()),
        "legit_both": int((top & flagged_by_rules & ~is_fraud).sum()),
        "legit_rules_only": int((~top & flagged_by_rules & ~is_fraud).sum()),
        "legit_model_only": int((top & ~flagged_by_rules & ~is_fraud).sum()),
    }
    # The ten most anomalous lines, with the feature whose value is the most unusual (percentile rank).
    cols = FEATURE_SETS["metier"]
    pct = X[cols].rank(pct=True)
    extreme = (pct - 0.5).abs()
    top10 = np.argsort(-m["_score"], kind="stable")[:10]
    examples = []
    for i in top10:
        row = claims.iloc[i]
        feat = extreme.iloc[i].idxmax()
        examples.append(
            {
                "line_id": int(row.line_id),
                "date": row.service_date.strftime("%Y-%m-%d"),
                "act": ACTS[row.act_code].label,
                "amount": _r(row.billed_amount, 2),
                "score": _r(m["_score"][i], 3),
                "most_unusual": FEATURE_LABELS[feat],
                "most_unusual_value": _r(X.iloc[i][feat], 3),
                "flagged_by_rules": bool(flagged_by_rules[i]),
                "truth": int(row.fraud_scenario),
            }
        )
    for v in models.values():
        v.pop("_score")
        v.pop("_top")
    return {
        "budget": budget,
        "rules": at_budget(flagged_by_rules),
        "models": models,
        "overlap": overlap,
        "examples": examples,
        "n_lines": len(claims),
        "n_fraud": int(is_fraud.sum()),
        "trees": N_TREES,
    }
