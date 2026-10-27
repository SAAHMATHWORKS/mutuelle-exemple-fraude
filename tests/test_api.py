import pytest
from fastapi.testclient import TestClient

import app.state as app_state
from app.main import app


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok" and body["claims"] > 0 and body["alerts"] > 0


def test_index_page_is_served_with_synthetic_data_footer(client):
    r = client.get("/")
    assert r.status_code == 200
    assert "Données entièrement synthétiques" in r.text
    assert r.headers["x-content-type-options"] == "nosniff"
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert client.get("/static/vendor/chart.umd.min.js").status_code == 200


def test_overview_contract(client):
    body = client.get("/api/overview").json()
    assert {"dataset", "totals", "per_scenario", "per_day", "scenarios", "decisions"} <= body.keys()
    assert len(body["per_scenario"]) == 5
    assert len(body["per_day"]) == 365
    assert {"date", "s1", "s2", "s3", "s4", "s5"} == body["per_day"][0].keys()
    assert sum(s["alerts"] for s in body["per_scenario"]) == body["totals"]["alerts"]


def test_alert_list_filters_and_pagination(client):
    page = client.get("/api/alerts", params={"page_size": 10}).json()
    assert {"total", "page", "page_size", "pages", "items"} == page.keys()
    assert len(page["items"]) == 10
    item = page["items"][0]
    assert {"id", "scenario", "severity", "date", "member_id", "amount", "decision", "decision_label", "reason"} <= item.keys()
    dates = [i["date"] for i in page["items"]]
    assert dates == sorted(dates, reverse=True)

    only = client.get("/api/alerts", params={"scenario": 4, "page_size": 100}).json()
    assert only["items"] and {i["scenario"] for i in only["items"]} == {4}

    high = client.get("/api/alerts", params={"severity": "haute", "date_from": "2025-06-01", "date_to": "2025-06-30"}).json()
    assert all(i["severity"] == "haute" and "2025-06-01" <= i["date"] <= "2025-06-30" for i in high["items"])

    member = item["member_id"]
    found = client.get("/api/alerts", params={"q": member.lower()}).json()
    assert found["total"] >= 1 and all(member in (i["member_id"], i["provider_id"]) or member in i["id"] for i in found["items"])


@pytest.mark.parametrize(
    "params", [{"page_size": 1000}, {"scenario": 9}, {"severity": "énorme"}, {"decision": "inventée"}, {"page": 0}]
)
def test_alert_list_rejects_bad_parameters(client, params):
    assert client.get("/api/alerts", params=params).status_code == 422


def test_alert_detail_contract(client):
    first_price = client.get("/api/alerts", params={"scenario": 1, "page_size": 1}).json()["items"][0]
    body = client.get(f"/api/alerts/{first_price['id']}").json()
    assert {"reason", "decision_label", "details", "evidence", "chart", "ground_truth"} <= body.keys()
    assert body["evidence"] and any(r["role"] == "signalée" for r in body["evidence"])
    chart = body["chart"]
    assert chart["reference_median"] > 0 and chart["past"]
    assert all(p["date"] < chart["claim"]["date"] for p in chart["past"])  # chart shows only earlier invoices
    assert client.get("/api/alerts/S9-99999").status_code == 404


def test_evaluation_contract(client):
    body = client.get("/api/evaluation").json()
    assert {"per_scenario", "overall", "false_alert_causes", "per_day", "noise_curve"} <= body.keys()
    for row in body["per_scenario"]:
        assert {"recall", "precision", "false_alerts_per_day", "alerts_per_day"} <= row.keys()
        assert 0 <= row["recall"] <= 1 and 0 <= row["precision"] <= 1
    assert body["noise_curve"]["status"] in {"computing", "ready"}


def test_exploration_contract(client):
    body = client.get("/api/exploration").json()
    assert {"dataset", "summary", "portfolio", "signals"} <= body.keys()
    portfolio_keys = {"amounts", "price_spread", "seasonality", "daily", "provider_mix", "concentration", "age_spend"}
    assert portfolio_keys == body["portfolio"].keys()
    assert {"labels", "price", "duplicates", "providers", "coherence", "early"} == body["signals"].keys()
    assert body["summary"]["n_claims"] == body["dataset"]["n_claims"]
    for key in ("price", "duplicates", "providers", "early"):
        sig = body["signals"][key]
        assert len(sig["legit_share"]) == len(sig["fraud_share"]) == len(sig["legit_counts"])
        assert {"legit_rule_share", "fraud_rule_share", "n_legit", "n_fraud"} <= sig.keys()


def test_regenerate_validates_and_is_rate_limited(client, monkeypatch):
    monkeypatch.setattr(app_state, "limiter", app_state.RateLimiter(per_client_seconds=60, global_per_minute=6))
    assert client.post("/api/regenerate", json={"size": 10_000_000}).status_code == 422
    assert client.post("/api/regenerate", json={"noise_level": 3}).status_code == 422

    ok = client.post("/api/regenerate", json={"seed": 9, "size": 3_000, "noise_level": 0.4})
    assert ok.status_code == 200
    assert ok.json()["dataset"]["seed"] == 9
    assert client.get("/api/overview").json()["dataset"]["noise_level"] == 0.4

    again = client.post("/api/regenerate", json={"seed": 10, "size": 3_000, "noise_level": 0.4})
    assert again.status_code == 429 and int(again.headers["retry-after"]) > 0
