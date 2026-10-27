import pandas as pd
import pytest

from app.catalog import DECISIONS, SCENARIOS
from app.detectors import coherence, duplicates, early_claim, nomadism, price


@pytest.mark.parametrize("scenario", sorted(SCENARIOS))
def test_each_detector_recovers_most_of_its_injected_cases_at_low_noise(low_noise_result, scenario):
    row = next(p for p in low_noise_result.evaluation["per_scenario"] if p["scenario"] == scenario)
    assert row["injected_lines"] > 50
    assert row["recall"] >= 0.85, row
    assert row["precision"] >= 0.6, row


def test_performance_degrades_with_noise(low_noise_result, high_noise_result):
    low = low_noise_result.evaluation["overall"]
    high = high_noise_result.evaluation["overall"]
    assert high["recall_any"] < low["recall_any"] - 0.2
    assert high["false_alerts_per_day"] > low["false_alerts_per_day"]


def test_every_alert_is_explained(low_noise_result):
    lines = set(low_noise_result.dataset.claims.line_id)
    for a in low_noise_result.alerts:
        assert a["severity"] in {"haute", "moyenne", "faible"}
        assert a["decision"] in DECISIONS
        assert len(a["reason"]) > 30
        assert "facturé" in a["reason"] or "adhérent" in a["reason"]
        assert a["line_ids"] and set(a["line_ids"]) <= lines
        assert set(a["context_line_ids"]) <= lines


# --- small hand-made cases: one per scenario -------------------------------------------------
def _frame(rows):
    base = {"provider_type": "GEN", "diagnosis_code": "RSP-01", "policy_start_day": -500, "member_id": "M1"}
    df = pd.DataFrame([{**base, **r} for r in rows])
    df.insert(0, "line_id", range(1, len(df) + 1))
    return df


def test_exact_duplicate_is_flagged_and_original_kept_as_context():
    df = _frame(
        [
            {"day": 10, "provider_id": "P1", "act_code": "CONS-GEN", "billed_amount": 30.0},
            {"day": 10, "provider_id": "P1", "act_code": "CONS-GEN", "billed_amount": 30.0},
        ]
    )
    alerts = duplicates.detect(df, price.reference_prices(df))
    assert len(alerts) == 1
    assert alerts[0].line_ids == [2] and alerts[0].context_line_ids == [1]
    assert alerts[0].severity == "haute"


def test_physio_sessions_two_days_apart_are_not_duplicates():
    df = _frame([{"day": d, "provider_id": "K1", "act_code": "KINE-SEA", "billed_amount": 24.0} for d in (3, 5, 7)])
    assert duplicates.detect(df, price.reference_prices(df)) == []


def test_glasses_for_back_pain_are_incoherent():
    df = _frame(
        [
            {"day": 5, "provider_id": "O1", "act_code": "OPT-LUN", "diagnosis_code": "MSK-01", "billed_amount": 240.0},
            {"day": 6, "provider_id": "O1", "act_code": "OPT-LUN", "diagnosis_code": "OPH-01", "billed_amount": 240.0},
        ]
    )
    alerts = coherence.detect(df)
    assert [a.line_ids for a in alerts] == [[1]]
    assert alerts[0].decision == "demander_justificatif"


def test_costly_claim_three_days_after_start_is_flagged():
    df = _frame(
        [
            {"day": 103, "policy_start_day": 100, "provider_id": "D1", "act_code": "DENT-COU", "billed_amount": 520.0},
            {"day": 200, "policy_start_day": 100, "provider_id": "D1", "act_code": "DENT-COU", "billed_amount": 520.0},
        ]
    )
    alerts = early_claim.detect(df)
    assert [a.line_ids for a in alerts] == [[1]] and alerts[0].severity == "haute"


def test_three_new_doctors_in_a_week_are_flagged():
    rows = [{"day": 1, "provider_id": "G0", "act_code": "CONS-GEN", "billed_amount": 28.0}]  # usual doctor
    rows += [{"day": 50 + i * 2, "provider_id": f"G{i + 1}", "act_code": "CONS-GEN", "billed_amount": 28.0} for i in range(3)]
    alerts = nomadism.detect(_frame(rows))
    assert len(alerts) == 1 and alerts[0].line_ids == [2, 3, 4]
    assert "3 nouveaux médecins généralistes" in alerts[0].reason


def test_price_rule_with_a_threshold_nothing_reaches():
    from app.detectors import price
    from app.generator import generate
    from app.pipeline import run

    r = run(generate(seed=9, size=3_000, noise_level=0.4))
    assert price.detect(r.dataset.claims, r.refs, ratio_flag=1_000.0) == []


def test_early_claim_rule_with_no_window():
    from app.detectors import early_claim
    from app.generator import generate

    claims = generate(seed=9, size=3_000).claims
    assert early_claim.detect(claims.iloc[:0], max_days=30) == []
