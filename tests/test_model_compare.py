import numpy as np
import pandas as pd
import pytest

from app.model_compare import _new_providers_14d, compare, features


def test_new_providers_feature_counts_first_visits_in_the_last_14_days():
    claims = pd.DataFrame(
        {
            "member_id": ["M1"] * 5,
            "provider_type": ["GEN"] * 5,
            "provider_id": ["P1", "P2", "P1", "P3", "P4"],
            "day": [0, 3, 10, 12, 40],
        }
    )
    # day 0: P1 new -> 1; day 3: P1, P2 -> 2; day 10: still 2; day 12: P1, P2, P3 -> 3; day 40: only P4 -> 1
    assert list(_new_providers_14d(claims)) == [1, 2, 2, 3, 1]


def test_features_are_finite_and_label_free(low_noise_result):
    r = low_noise_result
    X = features(r.dataset.claims, r.refs, r.dataset.members)
    assert len(X) == len(r.dataset.claims)
    assert np.isfinite(X.to_numpy()).all()
    assert not any("fraud" in c for c in X.columns)


@pytest.fixture(scope="module")
def comparison(low_noise_result):
    r = low_noise_result
    return compare(r.dataset, r.refs, r.alerts)


def test_model_is_compared_at_the_same_workload(low_noise_result, comparison):
    rule_lines = {i for a in low_noise_result.alerts for i in a["line_ids"]}
    assert comparison["budget"] == len(rule_lines)
    for m in comparison["models"].values():
        assert m["at_budget"]["flagged"] == comparison["budget"]
    o = comparison["overlap"]
    assert o["fraud_both"] + o["fraud_rules_only"] + o["fraud_model_only"] + o["fraud_neither"] == comparison["n_fraud"]


def test_rules_beat_the_model_and_domain_features_beat_raw_ones(comparison):
    rules = comparison["rules"]["recall"]
    metier = comparison["models"]["metier"]["at_budget"]["recall"]
    brutes = comparison["models"]["brutes"]["at_budget"]["recall"]
    assert rules > metier > brutes
