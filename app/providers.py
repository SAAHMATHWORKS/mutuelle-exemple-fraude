"""Provider analysis for the "Prestataires et réseau" view.

* ``alert_heatmap``: alerts per provider and per week, for the providers with
  the most alerts (where do alerts concentrate, and when).
* ``scorecard``: a billing profile per provider (volume, price level versus
  the point-in-time reference, share of high prices, alert rate), shown as a
  heat map with one colour scale per column.
* ``network``: a member-provider graph for members flagged by the provider
  multiplication rule, next to loyal members for contrast.

The generator injected some inflated prices through a handful of "complicit"
providers; they are marked as such (ground truth, shown because the data is
synthetic). The rules never see this list.
"""

from __future__ import annotations

import networkx as nx
import numpy as np
import pandas as pd

from app.catalog import PROVIDER_TYPES, SCENARIOS
from app.detectors import nomadism
from app.generator import N_DAYS

HEATMAP_PROVIDERS = 25
SCORECARD_PROVIDERS = 25
SCORECARD_MIN_LINES = 40
GRAPH_FLAGGED = 14
GRAPH_CONTRAST = 8


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


def alert_heatmap(alerts: list[dict], providers: pd.DataFrame, complicit: set[str]) -> dict:
    n_weeks = (N_DAYS + 6) // 7
    rows: dict[str, np.ndarray] = {}
    by_scenario: dict[str, dict[str, int]] = {}
    for a in alerts:
        p = a["provider_id"]
        if p is None:  # provider multiplication alerts involve several providers
            continue
        rows.setdefault(p, np.zeros(n_weeks, dtype=int))[a["alert_day"] // 7] += 1
        by_scenario.setdefault(p, {str(s): 0 for s in SCENARIOS})[str(a["scenario"])] += 1
    ptype = dict(zip(providers.provider_id, providers.provider_type, strict=True))
    top = sorted(rows, key=lambda p: (-rows[p].sum(), p))[:HEATMAP_PROVIDERS]
    return {
        "weeks": n_weeks,
        "rows": [
            {
                "provider_id": p,
                "type": PROVIDER_TYPES[ptype[p]],
                "complicit": p in complicit,
                "total": int(rows[p].sum()),
                "by_scenario": by_scenario[p],
                "counts": [int(c) for c in rows[p]],
            }
            for p in top
        ],
        "max": int(max((rows[p].max() for p in top), default=0)),
        "providers_with_alerts": len(rows),
    }


def scorecard(claims: pd.DataFrame, refs: pd.DataFrame, alerts: list[dict], providers: pd.DataFrame, complicit: set[str]) -> dict:
    ratio = (claims.billed_amount / refs.ref_median).rename("ratio")
    df = claims[["provider_id", "member_id", "billed_amount", "line_id"]].join(ratio)
    alert_count: dict[str, int] = {}
    for a in alerts:
        if a["provider_id"] is not None:
            alert_count[a["provider_id"]] = alert_count.get(a["provider_id"], 0) + 1
    ptype = dict(zip(providers.provider_id, providers.provider_type, strict=True))
    rows = []
    for p, grp in df.groupby("provider_id", sort=True):
        if len(grp) < SCORECARD_MIN_LINES:
            continue
        known = grp.ratio.dropna()
        rows.append(
            {
                "provider_id": p,
                "type": PROVIDER_TYPES[ptype[p]],
                "complicit": p in complicit,
                "lines": len(grp),
                "members": int(grp.member_id.nunique()),
                "median_ratio": _r(known.median(), 3) if len(known) else None,
                "share_above_1_5": _r((known >= 1.5).mean(), 4) if len(known) else None,
                "alerts_per_100": _r(100 * alert_count.get(p, 0) / len(grp), 2),
            }
        )
    rows.sort(key=lambda r: (-(r["share_above_1_5"] or 0), -(r["median_ratio"] or 0), r["provider_id"]))
    shown = rows[:SCORECARD_PROVIDERS]
    columns = ["lines", "median_ratio", "share_above_1_5", "alerts_per_100"]
    # Percentile rank of each value among all eligible providers, for the colour scale of its column.
    for col in columns:
        values = pd.Series([r[col] for r in rows], dtype=float)
        ranks = values.rank(pct=True)
        for r, rk in zip(rows, ranks, strict=True):
            r.setdefault("rank", {})[col] = None if pd.isna(rk) else _r(rk, 3)
    return {
        "columns": columns,
        "rows": shown,
        "eligible": len(rows),
        "complicit_in_top": sum(r["complicit"] for r in shown),
        "complicit_total": len(complicit),
    }


def network(claims: pd.DataFrame, alerts: list[dict], seed: int) -> dict:
    watched = claims[claims.provider_type.isin(nomadism.WATCHED_TYPES)]
    s3_alerts = [a for a in alerts if a["scenario"] == 3]
    flagged_lines = {i for a in s3_alerts for i in a["line_ids"]}
    injected = set(claims.loc[claims.fraud_scenario == 3, "member_id"])
    per_member = watched.groupby("member_id").provider_id.nunique()

    flagged_members: dict[str, int] = {}
    for a in s3_alerts:
        flagged_members[a["member_id"]] = flagged_members.get(a["member_id"], 0) + len(a["line_ids"])
    chosen = sorted(flagged_members, key=lambda m: (-flagged_members[m], m))[:GRAPH_FLAGGED]
    # Contrast: busy but loyal members (many visits, few providers), never flagged by the rule.
    visits = watched.groupby("member_id").size()
    loyal = (visits / per_member).sort_values(ascending=False)
    contrast = [m for m in loyal.index if m not in flagged_members and visits[m] >= 8][:GRAPH_CONTRAST]

    sub = watched[watched.member_id.isin(chosen + contrast)]
    g = nx.Graph()
    for m in chosen + contrast:
        g.add_node(m, kind="member", group="flagged" if m in flagged_members else "contrast", injected=m in injected)
    edges = sub.groupby(["member_id", "provider_id"]).agg(visits=("line_id", "size"), ptype=("provider_type", "first"))
    flagged_pairs = set(map(tuple, sub[sub.line_id.isin(flagged_lines)][["member_id", "provider_id"]].to_numpy()))
    for (m, p), row in edges.iterrows():
        if p not in g:
            g.add_node(p, kind="provider", ptype=PROVIDER_TYPES[row.ptype])
        g.add_edge(m, p, visits=int(row.visits), in_alert=(m, p) in flagged_pairs)
    pos = nx.spring_layout(g, seed=seed, k=0.55, iterations=200)
    xs = np.array([v[0] for v in pos.values()])
    ys = np.array([v[1] for v in pos.values()])
    span = max(xs.max() - xs.min(), ys.max() - ys.min(), 1e-9)

    def norm(v: float, lo: float) -> float:
        return _r((v - lo) / span, 4)

    nodes = []
    for n, data in g.nodes(data=True):
        x, y = pos[n]
        node = {"id": n, "kind": data["kind"], "x": norm(x, xs.min()), "y": norm(y, ys.min()), "degree": g.degree(n)}
        if data["kind"] == "member":
            node.update(
                group=data["group"], injected=data["injected"], visits=int(sum(d["visits"] for _, _, d in g.edges(n, data=True)))
            )
        else:
            node.update(ptype=data["ptype"], shared=sum(1 for nb in g.neighbors(n)) > 1)
        nodes.append(node)
    links = [{"source": a, "target": b, "visits": d["visits"], "in_alert": d["in_alert"]} for a, b, d in g.edges(data=True)]

    def mean_of(members: list[str], f) -> float | None:
        return _r(np.mean([f(m) for m in members]), 2) if members else None

    return {
        "nodes": nodes,
        "links": links,
        "summary": {
            "flagged_members": len(flagged_members),
            "shown_flagged": len(chosen),
            "shown_contrast": len(contrast),
            "flagged_injected": sum(1 for m in chosen if m in injected),
            "mean_providers_flagged": mean_of(chosen, lambda m: g.degree(m)),
            "mean_providers_contrast": mean_of(contrast, lambda m: g.degree(m)),
            "mean_visits_per_provider_flagged": mean_of(chosen, lambda m: visits[m] / per_member[m]),
            "mean_visits_per_provider_contrast": mean_of(contrast, lambda m: visits[m] / per_member[m]),
            "shared_providers": sum(1 for n in nodes if n["kind"] == "provider" and n["shared"]),
            "providers": sum(1 for n in nodes if n["kind"] == "provider"),
        },
    }


def analyse(dataset, refs: pd.DataFrame, alerts: list[dict]) -> dict:
    complicit = set(dataset.meta.get("complicit_providers", []))
    return {
        "heatmap": alert_heatmap(alerts, dataset.providers, complicit),
        "scorecard": scorecard(dataset.claims, refs, alerts, dataset.providers, complicit),
        "network": network(dataset.claims, alerts, dataset.seed),
    }
