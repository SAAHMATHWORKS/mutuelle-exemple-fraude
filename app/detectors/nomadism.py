"""Scenario 3 — provider multiplication ("nomadisme médical").

For each member and provider type (GP, specialist, pharmacy), count the
providers seen in a 14-day window that the member had never used before the
window. Three or more new providers of the same type in 14 days raises an
alert covering those visits. The window ends at the line being scored, so the
alert is dated the day the pattern becomes visible; earlier lines of the same
burst are attached to it, as a daily review queue would do.
"""

from __future__ import annotations

import pandas as pd

from app.detectors.base import Alert

WINDOW_DAYS = 14
MIN_NEW_PROVIDERS = 3
WATCHED_TYPES = ("GEN", "SPE", "PHA")
_NOUNS = {  # (singular, plural, feminine)
    "GEN": ("médecin généraliste", "médecins généralistes", False),
    "SPE": ("médecin spécialiste", "médecins spécialistes", False),
    "PHA": ("pharmacie", "pharmacies", True),
}


def _phrase(ptype: str, n: int) -> str:
    sing, plur, fem = _NOUNS[ptype]
    adj = ("nouvelle" if fem else "nouveau") if n == 1 else ("nouvelles" if fem else "nouveaux")
    return f"{n} {adj} {sing if n == 1 else plur}"


def detect(claims: pd.DataFrame) -> list[Alert]:
    watched = claims[claims.provider_type.isin(WATCHED_TYPES)]
    # Pre-filter: a member can only trigger if three providers of one type were
    # first seen within WINDOW_DAYS of each other.
    first = (
        watched.groupby(["member_id", "provider_type", "provider_id"], sort=True)["day"]
        .min()
        .reset_index()
        .sort_values(["member_id", "provider_type", "day"])
    )
    grp_key = first["member_id"] + "|" + first["provider_type"]
    later = first["day"].shift(-(MIN_NEW_PROVIDERS - 1))
    ok = (grp_key == grp_key.shift(-(MIN_NEW_PROVIDERS - 1))) & (later - first["day"] <= WINDOW_DAYS - 1)
    suspects = set(first.loc[ok, "member_id"])
    watched = watched[watched.member_id.isin(suspects)]
    alerts: list[Alert] = []
    for member, lines in watched.groupby("member_id", sort=True):
        lines = lines.sort_values(["day", "line_id"])
        flagged: dict[int, int] = {}  # line_id -> day
        for _, typed in lines.groupby("provider_type", sort=True):
            days = typed["day"].to_numpy()
            provs = typed["provider_id"].to_numpy()
            ids = typed["line_id"].to_numpy()
            first_seen: dict[str, int] = {}
            for d, p in zip(days, provs, strict=True):
                first_seen.setdefault(p, int(d))
            for i in range(len(typed)):
                d = days[i]
                lo = d - WINDOW_DAYS + 1
                in_window = [k for k in range(i + 1) if days[k] >= lo]
                new_provs = {provs[k] for k in in_window if first_seen[provs[k]] >= lo}
                if len(new_provs) >= MIN_NEW_PROVIDERS:
                    for k in in_window:
                        if first_seen[provs[k]] >= lo:
                            flagged[int(ids[k])] = int(days[k])
        if not flagged:
            continue
        # Group flagged lines of this member into bursts separated by > WINDOW_DAYS.
        ordered = sorted(flagged.items(), key=lambda kv: (kv[1], kv[0]))
        bursts: list[list[tuple[int, int]]] = [[ordered[0]]]
        for item in ordered[1:]:
            if item[1] - bursts[-1][-1][1] > WINDOW_DAYS:
                bursts.append([item])
            else:
                bursts[-1].append(item)
        for burst in bursts:
            ids_b = [lid for lid, _ in burst]
            sub = lines[lines.line_id.isin(ids_b)]
            first, last = int(sub.day.min()), int(sub.day.max())
            per_type = sub.groupby("provider_type")["provider_id"].nunique().to_dict()
            biggest = max(per_type.values())
            parts = " et ".join(_phrase(t, n) for t, n in sorted(per_type.items()))
            context = lines[(lines.day >= first - WINDOW_DAYS) & (lines.day <= last) & ~lines.line_id.isin(ids_b)]
            alerts.append(
                Alert(
                    scenario=3,
                    severity="haute" if biggest >= 4 else "moyenne",
                    score=float(sum(per_type.values())),
                    alert_day=last,
                    member_id=member,
                    provider_id=None,
                    line_ids=sorted(ids_b),
                    context_line_ids=sorted(int(x) for x in context.line_id),
                    reason=(
                        f"En {last - first + 1} jours, l'adhérent s'est adressé à {parts}, "
                        "absents de son historique de soins. Ce parcours ressemble à une recherche de prescriptions multiples."
                    ),
                    decision="controle_medical",
                    details={"new_providers_by_type": per_type, "first_day": first, "last_day": last},
                )
            )
    return alerts
