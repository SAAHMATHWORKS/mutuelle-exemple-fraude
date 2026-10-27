"""Run the five detectors and evaluate them against the injected labels."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

import pandas as pd

from app.catalog import SCENARIOS
from app.detectors import coherence, duplicates, early_claim, nomadism, price
from app.detectors.base import Alert
from app.exploration import explore
from app.generator import N_DAYS, Dataset


@dataclass
class Result:
    dataset: Dataset
    refs: pd.DataFrame
    alerts: list[dict]
    alerts_by_id: dict[str, dict]
    evaluation: dict
    detect_in_s: float
    claims_by_line: pd.DataFrame = field(repr=False, default=None)
    exploration: dict | None = field(repr=False, default=None)

    def get_exploration(self) -> dict:
        """Exploratory aggregates, computed on first use and kept with this result."""
        if self.exploration is None:
            self.exploration = explore(self.dataset, self.refs)
        return self.exploration


def run_detectors(claims: pd.DataFrame) -> tuple[pd.DataFrame, list[Alert]]:
    refs = price.reference_prices(claims)
    alerts: list[Alert] = []
    alerts += price.detect(claims, refs)
    alerts += duplicates.detect(claims, refs)
    alerts += nomadism.detect(claims)
    alerts += coherence.detect(claims)
    alerts += early_claim.detect(claims)
    return refs, alerts


def _to_records(alerts: list[Alert], claims: pd.DataFrame) -> list[dict]:
    amount = dict(zip(claims.line_id, claims.billed_amount, strict=True))
    alerts = sorted(alerts, key=lambda a: (a.alert_day, a.scenario, a.line_ids[0]))
    counters = {s: 0 for s in SCENARIOS}
    out = []
    for a in alerts:
        counters[a.scenario] += 1
        out.append(
            {
                "id": f"S{a.scenario}-{counters[a.scenario]:05d}",
                "scenario": a.scenario,
                "scenario_label": SCENARIOS[a.scenario]["label"],
                "severity": a.severity,
                "score": round(a.score, 3),
                "alert_day": a.alert_day,
                "member_id": a.member_id,
                "provider_id": a.provider_id,
                "line_ids": a.line_ids,
                "context_line_ids": a.context_line_ids,
                "n_lines": len(a.line_ids),
                "amount": round(sum(amount[i] for i in a.line_ids), 2),
                "reason": a.reason,
                "decision": a.decision,
                "details": a.details,
            }
        )
    return out


def evaluate(claims: pd.DataFrame, alerts: list[dict]) -> dict:
    """Line-level recall and precision per scenario, plus alert-level volumes."""
    label = dict(zip(claims.line_id, claims.fraud_scenario, strict=True))
    oddity = dict(zip(claims.line_id, claims.legit_oddity, strict=True))
    amount = dict(zip(claims.line_id, claims.billed_amount, strict=True))
    per_scenario = []
    for s, meta in SCENARIOS.items():
        flagged = {i for a in alerts if a["scenario"] == s for i in a["line_ids"]}
        truth = {i for i, lab in label.items() if lab == s}
        tp = flagged & truth
        any_fraud = {i for i in flagged if label[i] != 0}
        s_alerts = [a for a in alerts if a["scenario"] == s]
        false_alerts = [a for a in s_alerts if all(label[i] == 0 for i in a["line_ids"])]
        per_scenario.append(
            {
                "scenario": s,
                "label": meta["label"],
                "injected_lines": len(truth),
                "flagged_lines": len(flagged),
                "true_positive_lines": len(tp),
                "recall": round(len(tp) / len(truth), 3) if truth else None,
                "precision": round(len(tp) / len(flagged), 3) if flagged else None,
                "precision_any_fraud": round(len(any_fraud) / len(flagged), 3) if flagged else None,
                "alerts": len(s_alerts),
                "false_alerts": len(false_alerts),
                "alerts_per_day": round(len(s_alerts) / N_DAYS, 2),
                "false_alerts_per_day": round(len(false_alerts) / N_DAYS, 2),
            }
        )
    all_flagged = {i for a in alerts for i in a["line_ids"]}
    fraud_lines = {i for i, lab in label.items() if lab != 0}
    false_alerts = [a for a in alerts if all(label[i] == 0 for i in a["line_ids"])]
    causes: dict[str, int] = {}
    for a in false_alerts:
        tags = {oddity[i] for i in a["line_ids"] if oddity[i]} or {"aucune particularité : la règle se trompe"}
        for t in tags:
            causes[t] = causes.get(t, 0) + 1
    per_day = []
    for d in range(N_DAYS):
        per_day.append({"day": d, "alerts": 0, "false_alerts": 0})
    for a in alerts:
        per_day[a["alert_day"]]["alerts"] += 1
    for a in false_alerts:
        per_day[a["alert_day"]]["false_alerts"] += 1
    fraud_amount = sum(amount[i] for i in fraud_lines)
    caught_amount = sum(amount[i] for i in fraud_lines & all_flagged)
    return {
        "per_scenario": per_scenario,
        "overall": {
            "fraud_lines": len(fraud_lines),
            "flagged_lines": len(all_flagged),
            "recall_any": round(len(fraud_lines & all_flagged) / len(fraud_lines), 3) if fraud_lines else None,
            "precision_any": round(len(fraud_lines & all_flagged) / len(all_flagged), 3) if all_flagged else None,
            "alerts": len(alerts),
            "false_alerts": len(false_alerts),
            "alerts_per_day": round(len(alerts) / N_DAYS, 2),
            "false_alerts_per_day": round(len(false_alerts) / N_DAYS, 2),
            "fraud_amount": round(fraud_amount, 2),
            "caught_amount": round(caught_amount, 2),
        },
        "false_alert_causes": dict(sorted(causes.items(), key=lambda kv: -kv[1])),
        "per_day": per_day,
    }


def run(dataset: Dataset) -> Result:
    t0 = time.perf_counter()
    claims = dataset.claims
    refs, raw = run_detectors(claims)
    alerts = _to_records(raw, claims)
    evaluation = evaluate(claims, alerts)
    return Result(
        dataset=dataset,
        refs=refs,
        alerts=alerts,
        alerts_by_id={a["id"]: a for a in alerts},
        evaluation=evaluation,
        detect_in_s=time.perf_counter() - t0,
        claims_by_line=claims.set_index("line_id", drop=False).rename_axis(None),
    )
