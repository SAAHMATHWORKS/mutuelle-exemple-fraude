"""Scenario 1 must never use claims dated on or after the claim being scored."""

import numpy as np
import pandas as pd

from app.detectors import price
from app.generator import generate


def _claims():
    return generate(seed=11, size=8_000, noise_level=0.2).claims


def test_reference_equals_brute_force_median_of_strictly_earlier_claims():
    claims = _claims()
    refs = price.reference_prices(claims)
    rng = np.random.default_rng(0)
    checked = 0
    for pos in rng.choice(len(claims), 400, replace=False):
        row = claims.iloc[pos]
        earlier = claims[(claims.act_code == row.act_code) & (claims.day < row.day)].billed_amount
        if len(earlier) >= price.MIN_HISTORY:
            assert refs.ref_median.iloc[pos] == np.median(earlier)
            checked += 1
        else:
            assert np.isnan(refs.ref_median.iloc[pos])
        assert refs.n_prior.iloc[pos] == len(earlier)
    assert checked > 200


def test_changing_the_future_does_not_change_past_scores():
    claims = _claims()
    cutoff = 180
    before = price.reference_prices(claims)

    # Rewrite the future: from the cutoff day on, every price is multiplied by 1000
    # and extra extreme invoices are added.
    future = claims.copy()
    future.loc[future.day >= cutoff, "billed_amount"] *= 1000
    extra = future[future.day >= cutoff].head(500).copy()
    extra["line_id"] += 10_000_000
    future = pd.concat([future, extra], ignore_index=True)
    after = price.reference_prices(future)

    known = claims.day <= cutoff  # the cutoff day itself only looks at earlier days
    pd.testing.assert_series_equal(
        before.ref_median[known].reset_index(drop=True),
        after.ref_median.iloc[: len(claims)][known.to_numpy()].reset_index(drop=True),
    )

    # And therefore the alerts raised before the cutoff are unchanged.
    alerts_before = [a for a in price.detect(claims, before) if a.alert_day < cutoff]
    alerts_after = [a for a in price.detect(future, after) if a.alert_day < cutoff]
    assert [(a.line_ids, a.score) for a in alerts_before] == [(a.line_ids, a.score) for a in alerts_after]


def test_same_day_claims_are_not_part_of_their_own_reference():
    rows = []
    for day in range(25):  # 25 normal invoices on 25 earlier days
        rows.append({"line_id": day + 1, "day": day, "act_code": "IRM", "billed_amount": 300.0})
    # Two invoices on day 30: one huge. Neither may influence the other's reference.
    rows.append({"line_id": 100, "day": 30, "act_code": "IRM", "billed_amount": 300.0})
    rows.append({"line_id": 101, "day": 30, "act_code": "IRM", "billed_amount": 99_999.0})
    claims = pd.DataFrame(rows)
    refs = price.reference_prices(claims)
    assert refs.ref_median.iloc[-1] == 300.0 and refs.ref_median.iloc[-2] == 300.0
    assert refs.n_prior.iloc[-1] == 25
