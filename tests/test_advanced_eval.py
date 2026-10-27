import itertools

import pytest

from app.advanced_eval import SWEEPS, advanced
from app.detectors import coherence, duplicates, early_claim, nomadism, price


@pytest.fixture(scope="module")
def adv(low_noise_result):
    r = low_noise_result
    return advanced(r.dataset.claims, r.refs, r.alerts)


def test_detectors_with_their_default_threshold_are_unchanged(low_noise_result):
    claims, refs = low_noise_result.dataset.claims, low_noise_result.refs

    def ids(alerts):
        return sorted(tuple(a.line_ids) for a in alerts)

    assert ids(price.detect(claims, refs)) == ids(price.detect(claims, refs, ratio_flag=price.RATIO_FLAG))
    assert ids(duplicates.detect(claims, refs)) == ids(duplicates.detect(claims, refs, max_gap_days=duplicates.MAX_GAP_DAYS))
    assert ids(nomadism.detect(claims)) == ids(nomadism.detect(claims, min_new=nomadism.MIN_NEW_PROVIDERS))
    assert ids(coherence.detect(claims)) == ids(coherence.detect(claims, min_amount=0))
    assert ids(early_claim.detect(claims)) == ids(early_claim.detect(claims, max_days=early_claim.MAX_DAYS))


def test_current_threshold_point_matches_the_main_evaluation(low_noise_result, adv):
    main = {p["scenario"]: p for p in low_noise_result.evaluation["per_scenario"]}
    for sweep in adv["sweeps"]:
        current = [p for p in sweep["points"] if p["is_current"]]
        assert len(current) == 1, sweep["scenario"]
        assert current[0]["recall"] == pytest.approx(main[sweep["scenario"]]["recall"], abs=1e-3)
        assert current[0]["precision"] == pytest.approx(main[sweep["scenario"]]["precision"], abs=1e-3)
        assert sweep["best_f1_threshold"] in SWEEPS[sweep["scenario"]]["values"]


def test_recall_moves_with_the_threshold_in_the_expected_direction(adv):
    by = {s["scenario"]: [p["recall"] for p in s["points"]] for s in adv["sweeps"]}
    # Stricter thresholds can only lose lines: ratio, minimum providers and minimum amount go up.
    for s in (1, 3, 4):
        assert by[s] == sorted(by[s], reverse=True), s
    # Looser thresholds can only gain lines: wider gap, longer delay.
    for s in (2, 5):
        assert by[s] == sorted(by[s]), s


def test_confusion_counts_add_up(low_noise_result, adv):
    claims = low_noise_result.dataset.claims
    assert sum(r["lines"] for r in adv["confusion"]["matrix"]) == len(claims)
    for r in adv["confusion"]["per_rule"]:
        assert r["tp"] + r["fp"] + r["fn"] + r["tn"] == len(claims)
        injected = (claims.fraud_scenario == r["scenario"]).sum()
        assert r["tp"] + r["fn"] == injected


def test_gain_curves_are_cumulative_and_bounded_by_the_ideal_order(adv):
    curves = adv["gain"]["curves"]
    for metric in ("lines", "amount"):
        oracle = curves["oracle"][metric]
        finals = set()
        for name in ("severity_amount", "amount", "chronological"):
            pts = curves[name][metric]
            ys = [p["y"] for p in pts]
            assert ys == sorted(ys), (name, metric)  # never decreases
            assert [p["k"] for p in pts] == [p["k"] for p in oracle]
            assert all(p["y"] <= o["y"] + 1e-9 for p, o in zip(pts, oracle, strict=True)), (name, metric)
            finals.add(pts[-1]["y"])
        assert len(finals) == 1  # every order ends with all alerts reviewed


def test_high_severity_alerts_are_more_often_right(adv):
    share = {s["severity"]: s["share_true"] for s in adv["severity"]}
    assert share["haute"] > share["moyenne"] > share["faible"]


def test_economics_cumulative_euros_and_optimum(adv):
    from app.advanced_eval import best_net

    eco = adv["economics"]
    n = eco["alerts"]
    for series in eco["cum_fraud_eur"].values():
        assert len(series) == n + 1 and series[0] == 0
        assert all(b >= a for a, b in itertools.pairwise(series))
        assert series[-1] <= eco["fraud_total"] + 0.01
    # every order ends with the same fraud found (all alerts handled)
    ends = {round(s[-1], 2) for s in eco["cum_fraud_eur"].values()}
    assert len(ends) == 1
    d = eco["defaults"]
    for name, best in eco["best"].items():
        cum = eco["cum_fraud_eur"][name]
        nets = [d["recovery_rate"] * f - d["cost_per_alert"] * k for k, f in enumerate(cum)]
        assert best["net"] == pytest.approx(max(nets), abs=0.01)
        assert best["net"] >= best["net_all"] and best["net"] >= 0
    # free investigations: handle everything; prohibitive ones: handle nothing
    cum = eco["cum_fraud_eur"]["amount"]
    assert best_net(cum, eco["fraud_total"], 0.0, 1.0)["k"] == cum.index(max(cum))
    assert best_net(cum, eco["fraud_total"], 1e9, 1.0)["k"] == 0
