"""Scenario 4 — diagnosis / act incoherence.

A small rules table (``Act.allowed_groups`` in ``app.catalog``) lists the
diagnosis groups each act normally goes with. A line whose diagnosis is not
in that list is flagged. Very small amounts get "aucune action": a control
would cost more than the line.
"""

from __future__ import annotations

import pandas as pd

from app.catalog import ACTS, DIAGNOSES, DIAGNOSIS_GROUPS, diagnosis_group
from app.detectors.base import Alert, euros

HIGH_AMOUNT = 150.0
MIN_AMOUNT_FOR_ACTION = 25.0


def detect(claims: pd.DataFrame) -> list[Alert]:
    def coherent(act: str, diag: str) -> bool:
        allowed = ACTS[act].allowed_groups
        return allowed is None or diagnosis_group(diag) in allowed

    mask = [not coherent(a, d) for a, d in zip(claims.act_code, claims.diagnosis_code, strict=True)]
    hits = claims[mask]
    by_member = claims.groupby("member_id").indices
    alerts: list[Alert] = []
    for row in hits.itertuples(index=False):
        act = ACTS[row.act_code]
        allowed = ", ".join(DIAGNOSIS_GROUPS[g].lower() for g in sorted(act.allowed_groups or []))
        amount = float(row.billed_amount)
        small = amount < MIN_AMOUNT_FOR_ACTION
        own = claims.iloc[by_member[row.member_id]]
        context = own[(own.day <= row.day) & (own.day >= row.day - 30) & (own.line_id != row.line_id)]
        alerts.append(
            Alert(
                scenario=4,
                severity="haute" if amount >= HIGH_AMOUNT else ("faible" if small else "moyenne"),
                score=amount,
                alert_day=int(row.day),
                member_id=row.member_id,
                provider_id=row.provider_id,
                line_ids=[int(row.line_id)],
                context_line_ids=[int(x) for x in context.line_id],
                reason=(
                    f"Acte « {act.label} » ({euros(amount)}) facturé pour le diagnostic « {DIAGNOSES[row.diagnosis_code]} ». "
                    f"Cet acte va normalement avec un diagnostic de type : {allowed}."
                    + (" Montant trop faible pour justifier un contrôle." if small else "")
                ),
                decision="aucune_action" if small else "demander_justificatif",
                details={
                    "diagnosis_group": diagnosis_group(row.diagnosis_code),
                    "expected_groups": sorted(act.allowed_groups or []),
                },
            )
        )
    return alerts
