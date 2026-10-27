from app.providers import analyse


def test_provider_heatmap_and_scorecard(low_noise_result):
    r = low_noise_result
    x = analyse(r.dataset, r.refs, r.alerts)
    heat = x["heatmap"]
    totals = [row["total"] for row in heat["rows"]]
    assert totals == sorted(totals, reverse=True)
    for row in heat["rows"]:
        assert sum(row["counts"]) == row["total"] == sum(row["by_scenario"].values())
        assert len(row["counts"]) == heat["weeks"]
    card = x["scorecard"]
    complicit = set(r.dataset.meta["complicit_providers"])
    # Aggregating per provider puts the providers that inflate prices at the top of the profile.
    top = [row["provider_id"] for row in card["rows"][: len(complicit)]]
    assert set(top) == complicit
    for row in card["rows"]:
        assert all(0 <= v <= 1 for v in row["rank"].values() if v is not None)


def test_member_provider_graph_is_consistent(low_noise_result):
    r = low_noise_result
    net = analyse(r.dataset, r.refs, r.alerts)["network"]
    ids = {n["id"] for n in net["nodes"]}
    assert all(link["source"] in ids and link["target"] in ids for link in net["links"])
    assert all(0 <= n["x"] <= 1 and 0 <= n["y"] <= 1 for n in net["nodes"])
    s = net["summary"]
    assert s["shown_flagged"] > 0 and s["shown_contrast"] > 0
    assert s["mean_providers_flagged"] > s["mean_providers_contrast"]
    assert s["mean_visits_per_provider_flagged"] < s["mean_visits_per_provider_contrast"]
