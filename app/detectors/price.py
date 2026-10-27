"""Scenario 1: inflated price versus the usual price of the act.

The reference price of a line is the median billed amount of the same act
over all claims dated STRICTLY BEFORE the line's date. Lines of the same day
are never part of their own reference, and nothing after the date is used.
"""

from __future__ import annotations

from bisect import insort

import numpy as np
import pandas as pd

from app.catalog import ACTS
from app.detectors.base import Alert, euros

MIN_HISTORY = 20  # earlier lines needed before a reference is trusted
RATIO_FLAG = 2.0  # flag from 2x the usual price
RATIO_HIGH = 3.0  # high severity from 3x
PROVIDER_LOOKBACK_DAYS = 90
PROVIDER_REPEAT = 2  # earlier price alerts at the same provider -> provider audit


def _median(sorted_values: list[float]) -> float:
    n = len(sorted_values)
    mid = n // 2
    return sorted_values[mid] if n % 2 else (sorted_values[mid - 1] + sorted_values[mid]) / 2


def reference_prices(claims: pd.DataFrame, min_history: int = MIN_HISTORY) -> pd.DataFrame:
    """Point-in-time median price per line, using only earlier days.

    Returns a frame indexed like ``claims`` with ``ref_median`` (NaN when fewer
    than ``min_history`` earlier lines exist) and ``n_prior``.
    """
    ref = np.full(len(claims), np.nan)
    n_prior = np.zeros(len(claims), dtype=int)
    days = claims["day"].to_numpy()
    amounts = claims["billed_amount"].to_numpy(dtype=float)
    for _, idx in claims.groupby("act_code", sort=True).indices.items():
        order = idx[np.argsort(days[idx], kind="stable")]
        history: list[float] = []
        i = 0
        while i < len(order):
            day = days[order[i]]
            j = i
            while j < len(order) and days[order[j]] == day:
                j += 1
            same_day = order[i:j]
            if len(history) >= min_history:
                ref[same_day] = _median(history)
            n_prior[same_day] = len(history)
            for k in same_day:  # only now does this day join the history
                insort(history, amounts[k])
            i = j
    return pd.DataFrame({"ref_median": ref, "n_prior": n_prior}, index=claims.index)


def detect(claims: pd.DataFrame, refs: pd.DataFrame, ratio_flag: float = RATIO_FLAG) -> list[Alert]:
    ratio = claims["billed_amount"] / refs["ref_median"]
    mask = ratio >= ratio_flag
    # Select the same rows in every column: assigning a full Series to an empty frame would adopt its index.
    hits = claims[mask].assign(ratio=ratio[mask], ref=refs["ref_median"][mask], n_prior=refs["n_prior"][mask])
    alerts: list[Alert] = []
    provider_alert_days: dict[str, list[int]] = {}
    for row in hits.sort_values(["day", "line_id"]).itertuples(index=False):
        earlier = [d for d in provider_alert_days.get(row.provider_id, []) if row.day - d <= PROVIDER_LOOKBACK_DAYS]
        repeat = len(earlier) >= PROVIDER_REPEAT
        act = ACTS[row.act_code]
        reason = (
            f"Acte « {act.label} » facturé {euros(row.billed_amount)}, soit {row.ratio:.1f}".replace(".", ",")
            + " fois le prix habituel "
            f"de cet acte ({euros(row.ref)}, médiane de {row.n_prior} factures antérieures)."
        )
        if repeat:
            reason += f" Ce prestataire a déjà eu {len(earlier)} alertes de prix ces {PROVIDER_LOOKBACK_DAYS} derniers jours."
        alerts.append(
            Alert(
                scenario=1,
                severity="haute" if row.ratio >= RATIO_HIGH or repeat else "moyenne",
                score=float(row.ratio),
                alert_day=int(row.day),
                member_id=row.member_id,
                provider_id=row.provider_id,
                line_ids=[int(row.line_id)],
                reason=reason,
                decision="controle_prestataire" if repeat else "demander_facture",
                details={
                    "ratio": round(float(row.ratio), 2),
                    "reference_median": round(float(row.ref), 2),
                    "n_prior": int(row.n_prior),
                    "provider_previous_price_alerts": len(earlier),
                },
            )
        )
        provider_alert_days.setdefault(row.provider_id, []).append(int(row.day))
    return alerts


def price_history(claims: pd.DataFrame, act_code: str, day: int, window_days: int = 120, max_points: int = 160) -> list[dict]:
    """Earlier prices of the same act, for the detail chart (strictly before ``day``)."""
    past = claims[(claims.act_code == act_code) & (claims.day < day) & (claims.day >= day - window_days)]
    if len(past) > max_points:
        past = past.iloc[np.linspace(0, len(past) - 1, max_points).astype(int)]
    return [{"day": int(d), "amount": float(a)} for d, a in zip(past.day, past.billed_amount, strict=True)]
