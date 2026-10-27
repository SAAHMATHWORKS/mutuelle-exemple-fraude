import numpy as np
import pandas as pd
import pytest

from app.catalog import ACTS, DIAGNOSES
from app.generator import MAX_SIZE, N_DAYS, generate


def test_same_seed_gives_identical_data():
    a = generate(seed=123, size=5_000, noise_level=0.3)
    b = generate(seed=123, size=5_000, noise_level=0.3)
    pd.testing.assert_frame_equal(a.claims, b.claims)
    pd.testing.assert_frame_equal(a.members, b.members)
    pd.testing.assert_frame_equal(a.providers, b.providers)
    pd.testing.assert_frame_equal(a.policies, b.policies)


def test_different_seed_gives_different_data():
    a = generate(seed=1, size=5_000)
    b = generate(seed=2, size=5_000)
    assert not a.claims[["member_id", "act_code", "billed_amount"]].equals(b.claims[["member_id", "act_code", "billed_amount"]])


def test_tables_and_labels_are_consistent():
    d = generate(seed=7, size=8_000, noise_level=0.2)
    c = d.claims
    assert {
        "line_id",
        "member_id",
        "provider_id",
        "policy_id",
        "service_date",
        "diagnosis_code",
        "act_code",
        "billed_amount",
        "fraud_scenario",
    } <= set(c.columns)
    assert abs(len(c) - 8_000) / 8_000 < 0.05
    assert c.line_id.is_unique and c.line_id.is_monotonic_increasing
    assert set(c.fraud_scenario.unique()) == {0, 1, 2, 3, 4, 5}
    assert c.act_code.isin(ACTS.keys()).all() and c.diagnosis_code.isin(DIAGNOSES.keys()).all()
    assert (c.billed_amount > 0).all()
    assert c.day.between(0, N_DAYS - 1).all()
    # No claim before the policy starts, and every claim points to a known member and provider.
    assert (c.day >= c.policy_start_day).all()
    assert c.member_id.isin(d.members.member_id).all()
    assert c.provider_id.isin(d.providers.provider_id).all()
    # Fraud stays a minority, as in real portfolios.
    assert 0.02 < (c.fraud_scenario > 0).mean() < 0.10


def test_noise_level_changes_the_data():
    calm = generate(seed=5, size=6_000, noise_level=0.0).claims
    noisy = generate(seed=5, size=6_000, noise_level=1.0).claims
    assert (noisy.legit_oddity != "").sum() > 3 * (calm.legit_oddity != "").sum()

    def spread(c):  # spread of legitimate GP consultation prices, on a log scale
        legit = c[(c.act_code == "CONS-GEN") & (c.fraud_scenario == 0) & (c.legit_oddity == "")]
        return np.log(legit.billed_amount).std()

    assert spread(noisy) > 2 * spread(calm)


@pytest.mark.parametrize("kwargs", [{"size": MAX_SIZE + 1}, {"size": 10}, {"noise_level": 1.5}, {"noise_level": -0.1}])
def test_invalid_parameters_are_rejected(kwargs):
    with pytest.raises(ValueError):
        generate(**kwargs)
