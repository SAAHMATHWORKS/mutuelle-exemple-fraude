import numpy as np
import pytest

from app.exploration import explore, histogram, lorenz, max_in_window, shares


def test_histogram_puts_out_of_range_values_in_the_edge_bins():
    edges = np.array([0.0, 1.0, 2.0, 3.0])
    assert histogram(np.array([-5.0, 0.5, 1.5, 2.5, 99.0]), edges) == [2, 1, 2]
    assert shares([1, 3]) == [0.25, 0.75]
    assert shares([0, 0]) == [0.0, 0.0]


def test_lorenz_and_gini_on_known_cases():
    equal = lorenz(np.ones(100))
    assert equal["gini"] == pytest.approx(0.0, abs=1e-3)
    assert equal["y"][50] == pytest.approx(0.5, abs=1e-3)

    one_takes_all = lorenz(np.array([0.0] * 99 + [1.0]))
    assert one_takes_all["gini"] == pytest.approx(0.99, abs=1e-2)
    assert one_takes_all["top10_share"] == pytest.approx(1.0)

    curve = lorenz(np.random.default_rng(0).lognormal(size=500))
    assert curve["x"][0] == 0 and curve["x"][-1] == 1
    assert curve["y"][0] == 0 and curve["y"][-1] == pytest.approx(1.0)
    assert all(b >= a for a, b in zip(curve["y"], curve["y"][1:], strict=False))  # cumulative: never decreases
    assert all(y <= x + 1e-9 for x, y in zip(curve["x"], curve["y"], strict=True))  # always under the diagonal


def test_max_in_window_counts_events_in_the_busiest_span():
    days = np.array([0, 3, 13, 14, 20, 21, 22])
    assert max_in_window(days, 14) == 5  # days 13..26 hold 13, 14, 20, 21 and 22
    assert max_in_window(np.array([5]), 14) == 1
    assert max_in_window(np.array([0, 14, 28]), 14) == 1


def test_exploration_is_consistent_with_the_dataset(low_noise_result):
    x = explore(low_noise_result.dataset, low_noise_result.refs)
    claims = low_noise_result.dataset.claims
    assert x["summary"]["n_claims"] == len(claims)
    p = x["portfolio"]
    assert sum(p["amounts"]["counts"]) == len(claims)
    assert sum(m["lines"] for m in p["provider_mix"]) == len(claims)
    assert sum(m["amount_share"] for m in p["provider_mix"]) == pytest.approx(1.0, abs=1e-3)
    assert sum(sum(g["counts"]) for g in p["seasonality"]["groups"]) == len(claims)
    assert sum(p["daily"]["lines"]) == len(claims) and len(p["daily"]["dates"]) == 365
    for row in p["price_spread"]:
        assert row["p5"] <= row["q1"] <= row["median"] <= row["q3"] <= row["p95"]
    assert 0 <= p["concentration"]["providers"]["gini"] <= 1
    assert len(p["age_spend"]["points"]) <= 1200


def test_each_signal_separates_injected_fraud_from_legitimate_lines_at_low_noise(low_noise_result):
    s = explore(low_noise_result.dataset, low_noise_result.refs)["signals"]
    for key in ("price", "duplicates", "providers"):
        sig = s[key]
        assert sig["n_fraud"] > 0 and sig["n_legit"] > 0
        assert sum(sig["legit_counts"]) == sig["n_legit"]
        assert sig["fraud_rule_share"] >= 0.8, key
        assert sig["legit_rule_share"] <= 0.05, key
    # Early claims: the rule catches the fraud, but legitimate anti-selection looks the same.
    assert s["early"]["fraud_rule_share"] >= 0.9
    assert s["coherence"]["acts"] and s["coherence"]["legit_incoherent_rate"] < 0.01
