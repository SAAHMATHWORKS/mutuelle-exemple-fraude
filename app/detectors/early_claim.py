"""Scenario 5 — costly claim very soon after the policy starts.

A line is flagged when it is dated within ``MAX_DAYS`` of the policy start
and is either a costly act or above ``MIN_AMOUNT``.
"""

from __future__ import annotations

import pandas as pd

from app.catalog import ACTS, COSTLY_ACTS
from app.detectors.base import Alert, euros
from app.generator import PERIOD_START

MAX_DAYS = 30
HIGH_DAYS = 7
MIN_AMOUNT = 150.0


def detect(claims: pd.DataFrame, max_days: int = MAX_DAYS) -> list[Alert]:
    since = claims["day"] - claims["policy_start_day"]
    costly = claims["act_code"].isin(COSTLY_ACTS) | (claims["billed_amount"] >= MIN_AMOUNT)
    mask = (since >= 0) & (since <= max_days) & costly
    hits = claims[mask].assign(since=since[mask])  # same rows in every column, even when none match
    by_member = claims.groupby("member_id").indices
    alerts: list[Alert] = []
    for row in hits.itertuples(index=False):
        start = (pd.Timestamp(PERIOD_START) + pd.Timedelta(days=int(row.policy_start_day))).strftime("%d/%m/%Y")
        own = claims.iloc[by_member[row.member_id]]
        context = own[(own.day <= row.day) & (own.line_id != row.line_id)]
        alerts.append(
            Alert(
                scenario=5,
                severity="haute" if row.since <= HIGH_DAYS else ("moyenne" if row.since <= 15 else "faible"),
                score=float(max_days - row.since) + float(row.billed_amount) / 100,
                alert_day=int(row.day),
                member_id=row.member_id,
                provider_id=row.provider_id,
                line_ids=[int(row.line_id)],
                context_line_ids=[int(x) for x in context.line_id],
                reason=(
                    f"Acte « {ACTS[row.act_code].label} » de {euros(row.billed_amount)} facturé {int(row.since)} jour"
                    f"{'s' if row.since > 1 else ''} après le début du contrat (date d'effet le {start})."
                ),
                decision="verifier_contrat",
                details={"days_since_start": int(row.since), "policy_start": start},
            )
        )
    return alerts
