"""Scenario 2: double billing or split billing.

Lines of the same member, provider and act are grouped into clusters when
they are at most ``MAX_GAP_DAYS`` apart. Acts that are legitimately repeated
(pharmacy, physiotherapy) only count when billed the same day for the same
amount.

* Split billing: every piece is well below the usual price of the act, and
  together they add up to roughly one usual price -> all pieces are flagged.
* Duplicate: otherwise, every line after the first is flagged.
"""

from __future__ import annotations

import pandas as pd

from app.catalog import ACTS
from app.detectors.base import Alert, euros

MAX_GAP_DAYS = 1
SPLIT_PIECE_MAX = 0.75  # each piece below 75 % of the usual price
SPLIT_SUM_RANGE = (0.6, 1.6)  # pieces add up to about one usual price


def _clusters(grp: pd.DataFrame, repeatable: bool, max_gap_days: int = MAX_GAP_DAYS) -> list[pd.DataFrame]:
    if repeatable:
        out = []
        for _, same in grp.groupby(["day", "billed_amount"], sort=True):
            if len(same) >= 2:
                out.append(same)
        return out
    days = grp["day"].to_numpy()
    out, start = [], 0
    for i in range(1, len(grp) + 1):
        if i == len(grp) or days[i] - days[i - 1] > max_gap_days:
            if i - start >= 2:
                out.append(grp.iloc[start:i])
            start = i
    return out


def detect(claims: pd.DataFrame, refs: pd.DataFrame, max_gap_days: int = MAX_GAP_DAYS) -> list[Alert]:
    keyed = claims.assign(ref=refs["ref_median"]).sort_values(["member_id", "provider_id", "act_code", "day", "line_id"])
    # Cheap vectorised pre-filter: keep only lines that have a neighbour of the same key.
    key = keyed["member_id"] + "|" + keyed["provider_id"] + "|" + keyed["act_code"]
    gap_prev = keyed["day"].diff()
    near_prev = (key == key.shift(1)) & (gap_prev <= max_gap_days)
    near = near_prev | near_prev.shift(-1, fill_value=False)
    repeatable = keyed["act_code"].map(lambda a: ACTS[a].repeatable)
    same_day_same_amount = keyed.duplicated(["member_id", "provider_id", "act_code", "day", "billed_amount"], keep=False)
    candidates = keyed[(~repeatable & near) | (repeatable & same_day_same_amount)]
    alerts: list[Alert] = []
    for (member, provider, act_code), grp in candidates.groupby(["member_id", "provider_id", "act_code"], sort=True):
        act = ACTS[act_code]
        grp = grp.sort_values(["day", "line_id"])
        for cl in _clusters(grp, act.repeatable, max_gap_days):
            amounts = cl["billed_amount"].tolist()
            ref = cl["ref"].iloc[0]
            total = sum(amounts)
            span = int(cl["day"].iloc[-1] - cl["day"].iloc[0])
            is_split = (
                not act.repeatable
                and pd.notna(ref)
                and all(a < SPLIT_PIECE_MAX * ref for a in amounts)
                and SPLIT_SUM_RANGE[0] * ref <= total <= SPLIT_SUM_RANGE[1] * ref
            )
            pieces = " + ".join(euros(a) for a in amounts)
            when = "le même jour" if span == 0 else f"en {span + 1} jours"
            if is_split:
                flagged = cl["line_id"].tolist()
                context: list[int] = []
                severity = "haute" if len(cl) >= 3 else "moyenne"
                reason = (
                    f"Acte « {act.label} » facturé en {len(cl)} morceaux {when} ({pieces} = {euros(total)}), "
                    f"alors que le prix habituel d'un seul acte est d'environ {euros(ref)}."
                )
                kind = "fractionnement"
            else:
                flagged = cl["line_id"].iloc[1:].tolist()
                context = cl["line_id"].iloc[:1].tolist()
                identical = len(set(amounts)) == 1
                severity = "haute" if identical and span == 0 else ("moyenne" if identical else "faible")
                reason = (
                    f"Acte « {act.label} » facturé {len(cl)} fois {when} pour le même adhérent par le même prestataire "
                    f"({pieces})." + (" Montants identiques." if identical else " Montants proches mais différents.")
                )
                kind = "doublon"
            alerts.append(
                Alert(
                    scenario=2,
                    severity=severity,
                    score=float(len(cl)) + (1.0 if severity == "haute" else 0.0),
                    alert_day=int(cl["day"].iloc[-1]),
                    member_id=member,
                    provider_id=provider,
                    line_ids=[int(x) for x in flagged],
                    context_line_ids=[int(x) for x in context],
                    reason=reason,
                    decision="demander_facture",
                    details={
                        "kind": kind,
                        "n_lines": len(cl),
                        "total": round(total, 2),
                        "reference_median": None if pd.isna(ref) else round(float(ref), 2),
                    },
                )
            )
    return alerts
