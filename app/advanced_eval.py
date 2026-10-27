"""Advanced evaluation: threshold sweeps, confusion matrices, gain curves.

All three answer questions a claims manager asks before trusting a rule:

* **Threshold sweeps** re-run the real detector of each scenario with other
  values of its main threshold and measure line-level precision and recall at
  each value (the precision-recall trade-off, and the alert volume it costs).
* **Confusion matrices** show, for every injected scenario, which rule flags
  its lines (cross-detection), and the classic 2 x 2 table per rule.
* **Gain curves** answer "if a handler can only review N alerts, how much of
  the fraud do they recover, depending on how the queue is sorted?".

Scores are measured against labels injected by the generator; they show how
well the rules recover the patterns that were planted, not real-world accuracy.
"""

from __future__ import annotations

from collections.abc import Callable

import numpy as np
import pandas as pd

from app.catalog import SCENARIOS
from app.detectors import coherence, duplicates, early_claim, nomadism, price
from app.detectors.base import SEVERITY_ORDER
from app.generator import N_DAYS

GAIN_POINTS = 200


def _r(x: float, nd: int = 4) -> float:
    return round(float(x), nd)


# Each scenario: its main threshold, the values swept, and how to run the real rule with one value.
SWEEPS: dict[int, dict] = {
    1: {
        "param": "ratio_flag",
        "label": "Rapport minimal au prix habituel",
        "unit": "×",
        "values": [1.2, 1.4, 1.6, 1.8, 2.0, 2.5, 3.0, 4.0],
        "current": price.RATIO_FLAG,
        "direction": "Plus le seuil est bas, plus la règle signale de lignes.",
    },
    2: {
        "param": "max_gap_days",
        "label": "Écart maximal entre deux factures identiques (jours)",
        "unit": "j",
        "values": [0, 1, 2, 3, 5, 7, 10],
        "current": duplicates.MAX_GAP_DAYS,
        "direction": "Plus l'écart toléré est grand, plus la règle regroupe de factures.",
    },
    3: {
        "param": "min_new",
        "label": "Nouveaux prestataires du même type en 14 jours (minimum)",
        "unit": "",
        "values": [2, 3, 4, 5],
        "current": nomadism.MIN_NEW_PROVIDERS,
        "direction": "Plus le minimum est bas, plus la règle signale d'adhérents.",
    },
    4: {
        "param": "min_amount",
        "label": "Montant minimal d'une ligne incohérente (€)",
        "unit": "€",
        "values": [0, 10, 25, 50, 100, 150],
        "current": 0,
        "direction": "Ignorer les petits montants réduit la charge, au prix de fraudes manquées.",
    },
    5: {
        "param": "max_days",
        "label": "Délai maximal après la date d'effet (jours)",
        "unit": "j",
        "values": [7, 15, 30, 45, 60, 90],
        "current": early_claim.MAX_DAYS,
        "direction": "Plus le délai est long, plus la règle signale de soins.",
    },
}


def _runner(scenario: int, claims: pd.DataFrame, refs: pd.DataFrame) -> Callable:
    return {
        1: lambda v: price.detect(claims, refs, ratio_flag=v),
        2: lambda v: duplicates.detect(claims, refs, max_gap_days=int(v)),
        3: lambda v: nomadism.detect(claims, min_new=int(v)),
        4: lambda v: coherence.detect(claims, min_amount=float(v)),
        5: lambda v: early_claim.detect(claims, max_days=int(v)),
    }[scenario]


def threshold_sweeps(claims: pd.DataFrame, refs: pd.DataFrame) -> list[dict]:
    label = dict(zip(claims.line_id, claims.fraud_scenario, strict=True))
    out = []
    for s, spec in SWEEPS.items():
        truth = {i for i, lab in label.items() if lab == s}
        run = _runner(s, claims, refs)
        points = []
        for v in spec["values"]:
            alerts = run(v)
            flagged = {i for a in alerts for i in a.line_ids}
            tp = len(flagged & truth)
            precision = tp / len(flagged) if flagged else None
            recall = tp / len(truth) if truth else None
            f1 = 2 * precision * recall / (precision + recall) if precision and recall else 0.0
            false_alerts = sum(1 for a in alerts if all(label[i] == 0 for i in a.line_ids))
            points.append(
                {
                    "threshold": v,
                    "is_current": v == spec["current"],
                    "flagged_lines": len(flagged),
                    "true_positive_lines": tp,
                    "precision": None if precision is None else _r(precision),
                    "recall": None if recall is None else _r(recall),
                    "f1": _r(f1),
                    "alerts": len(alerts),
                    "alerts_per_day": _r(len(alerts) / N_DAYS, 2),
                    "false_alerts_per_day": _r(false_alerts / N_DAYS, 2),
                }
            )
        best = max(points, key=lambda p: p["f1"])
        out.append(
            {
                "scenario": s,
                "label": SCENARIOS[s]["label"],
                "param": spec["param"],
                "param_label": spec["label"],
                "unit": spec["unit"],
                "direction": spec["direction"],
                "current": spec["current"],
                "best_f1_threshold": best["threshold"],
                "injected_lines": len(truth),
                "points": points,
            }
        )
    return out


def confusion(claims: pd.DataFrame, alerts: list[dict]) -> dict:
    """Which rule flags the lines of which injected scenario (lines can be flagged by several rules)."""
    label = claims.set_index("line_id").fraud_scenario
    flagged_by = {s: {i for a in alerts if a["scenario"] == s for i in a["line_ids"]} for s in SCENARIOS}
    any_flag = set().union(*flagged_by.values())
    rows = []
    for true_s in [0, *SCENARIOS]:
        lines = set(label.index[label == true_s])
        n = len(lines)
        rows.append(
            {
                "true_scenario": true_s,
                "label": "Légitime" if true_s == 0 else SCENARIOS[true_s]["label"],
                "lines": n,
                "by_rule": {str(r): len(lines & flagged_by[r]) for r in SCENARIOS},
                "none": len(lines - any_flag),
            }
        )
    n_total = len(label)
    per_rule = []
    for s in SCENARIOS:
        truth = set(label.index[label == s])
        flagged = flagged_by[s]
        tp = len(flagged & truth)
        fp = len(flagged - truth)
        fn = len(truth - flagged)
        tn = n_total - tp - fp - fn
        other_fraud = len({i for i in flagged - truth if label[i] != 0})
        precision = tp / (tp + fp) if tp + fp else None
        recall = tp / (tp + fn) if tp + fn else None
        per_rule.append(
            {
                "scenario": s,
                "label": SCENARIOS[s]["label"],
                "tp": tp,
                "fp": fp,
                "fn": fn,
                "tn": tn,
                "fp_other_fraud": other_fraud,
                "precision": None if precision is None else _r(precision),
                "recall": None if recall is None else _r(recall),
                "f1": _r(2 * precision * recall / (precision + recall)) if precision and recall else 0.0,
                "specificity": _r(tn / (tn + fp)) if tn + fp else None,
            }
        )
    return {"matrix": rows, "per_rule": per_rule}


def _downsample(xs: list[int], ys: list[float], points: int = GAIN_POINTS) -> list[dict]:
    idx = range(len(xs)) if len(xs) <= points else sorted(set(np.linspace(0, len(xs) - 1, points).round().astype(int)))
    return [{"k": xs[i], "y": _r(ys[i])} for i in idx]


def gain_curves(claims: pd.DataFrame, alerts: list[dict]) -> dict:
    label = dict(zip(claims.line_id, claims.fraud_scenario, strict=True))
    amount = dict(zip(claims.line_id, claims.billed_amount, strict=True))
    fraud_lines = {i for i, lab in label.items() if lab != 0}
    total_lines = len(fraud_lines)
    total_amount = sum(amount[i] for i in fraud_lines)

    def fraud_amount(a: dict) -> float:
        return sum(amount[i] for i in a["line_ids"] if label[i] != 0)

    def fraud_count(a: dict) -> int:
        return sum(1 for i in a["line_ids"] if label[i] != 0)

    orders = {
        "severity_amount": sorted(alerts, key=lambda a: (-SEVERITY_ORDER[a["severity"]], -a["amount"], a["id"])),
        "amount": sorted(alerts, key=lambda a: (-a["amount"], a["id"])),
        "chronological": sorted(alerts, key=lambda a: (a["alert_day"], a["id"])),
        # The ideal order depends on what is counted: most fraudulent euros first, or most fraudulent lines first.
        "oracle_amount": sorted(alerts, key=lambda a: (-fraud_amount(a), a["id"])),
        "oracle_lines": sorted(alerts, key=lambda a: (-fraud_count(a), -fraud_amount(a), a["id"])),
    }
    curves: dict[str, dict] = {}
    for name, ordered in orders.items():
        seen: set[int] = set()
        found_amount = 0.0
        ks, by_lines, by_amount = [0], [0.0], [0.0]
        for k, a in enumerate(ordered, start=1):
            for i in a["line_ids"]:
                if label[i] != 0 and i not in seen:
                    seen.add(i)
                    found_amount += amount[i]
            ks.append(k)
            by_lines.append(len(seen) / total_lines if total_lines else 0.0)
            by_amount.append(found_amount / total_amount if total_amount else 0.0)
        curves[name] = {"lines": _downsample(ks, by_lines), "amount": _downsample(ks, by_amount)}
    curves["oracle"] = {"lines": curves.pop("oracle_lines")["lines"], "amount": curves.pop("oracle_amount")["amount"]}
    n = len(alerts)
    final_lines = curves["oracle"]["lines"][-1]["y"]
    final_amount = curves["oracle"]["amount"][-1]["y"]
    curves["random"] = {
        "lines": [{"k": 0, "y": 0.0}, {"k": n, "y": final_lines}],
        "amount": [{"k": 0, "y": 0.0}, {"k": n, "y": final_amount}],
    }
    return {
        "alerts": n,
        "fraud_lines": total_lines,
        "fraud_amount": _r(total_amount, 2),
        "days": N_DAYS,
        "curves": curves,
    }


def severity_calibration(claims: pd.DataFrame, alerts: list[dict]) -> list[dict]:
    label = dict(zip(claims.line_id, claims.fraud_scenario, strict=True))
    out = []
    for sev in ("haute", "moyenne", "faible"):
        group = [a for a in alerts if a["severity"] == sev]
        right = sum(1 for a in group if any(label[i] != 0 for i in a["line_ids"]))
        share = _r(right / len(group)) if group else None
        out.append({"severity": sev, "alerts": len(group), "true_alerts": right, "share_true": share})
    return out


def advanced(claims: pd.DataFrame, refs: pd.DataFrame, alerts: list[dict]) -> dict:
    return {
        "sweeps": threshold_sweeps(claims, refs),
        "confusion": confusion(claims, alerts),
        "gain": gain_curves(claims, alerts),
        "severity": severity_calibration(claims, alerts),
    }
