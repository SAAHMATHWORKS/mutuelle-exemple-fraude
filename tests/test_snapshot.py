import pytest

from app import snapshot
from app.state import AppState


@pytest.fixture(scope="module")
def snapshot_path(tmp_path_factory):
    path = tmp_path_factory.mktemp("snap") / "demo.pkl.gz"
    info = snapshot.build(path, seed=7, size=3_000, noise_level=0.2)
    assert info["claims"] > 0 and info["alerts"] > 0 and info["bytes"] > 0
    return path


def test_snapshot_holds_every_precomputed_view(snapshot_path):
    payload = snapshot.load(snapshot_path)
    r = payload["result"]
    assert r.dataset.seed == 7
    assert r.advanced and "sweeps" in r.advanced
    assert r.model and "models" in r.model
    assert r.exploration and r.providers
    assert payload["curve"]["status"] == "ready" and len(payload["curve"]["levels"]) == 5


def test_state_serves_the_snapshot_read_only(snapshot_path):
    st = AppState()
    st.use_snapshot(str(snapshot_path))
    assert st.read_only and st.mode == "vitrine"
    r = st.current()
    assert r.dataset.seed == 7
    assert st.curve(r.dataset.seed, r.dataset.size)["status"] == "ready"  # no background job started


def test_api_in_showcase_mode(snapshot_path, monkeypatch):
    from fastapi.testclient import TestClient

    import app.main as main

    st = AppState()
    st.use_snapshot(str(snapshot_path))
    monkeypatch.setattr(main, "state", st)
    with TestClient(main.app) as client:
        health = client.get("/health").json()
        assert health["mode"] == "vitrine"
        assert client.get("/api/overview").json()["dataset"]["read_only"] is True
        # Everything is ready on the first call.
        assert client.get("/api/evaluation/advanced").json()["status"] == "ready"
        assert client.get("/api/model").json()["status"] == "ready"
        assert client.get("/api/evaluation").json()["noise_curve"]["status"] == "ready"
        refused = client.post("/api/regenerate", json={"seed": 1, "size": 3_000, "noise_level": 0.2})
        assert refused.status_code == 403
        assert "local" in refused.json()["detail"]
