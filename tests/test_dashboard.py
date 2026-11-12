"""Exercise browser sessions against real environment transitions."""

from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from server.dashboard import mount_dashboard


@pytest.fixture
def client():
    app = FastAPI()
    mount_dashboard(app)
    with TestClient(app) as client:
        yield client


def test_dashboard_assets_and_scenario_catalog(client):
    assert client.get("/").status_code == 200
    assert "Decision workspace" in client.get("/").text
    for asset in ("app.js", "styles.css", "benchmarks.json"):
        assert client.get(f"/assets/{asset}").status_code == 200
    scenarios = client.get("/ui/scenarios").json()["scenarios"]
    assert len(scenarios) == 3
    assert {len(s["agents"]) for s in scenarios} == {1, 2, 3}


def test_browser_sessions_do_not_share_state(client):
    first = client.post("/ui/sessions", json={}).json()
    second = client.post("/ui/sessions", json={}).json()
    session_id = first["session_id"]
    updated = client.post(f"/ui/sessions/{session_id}/step", json={
        "action_type": "log_reasoning", "payload": "This belongs only to the first session."
    }).json()
    assert updated["observation"]["turn"] == 1
    untouched = client.get(f"/ui/sessions/{second['session_id']}").json()
    assert untouched["observation"]["turn"] == 0
    assert untouched["observation"]["swd"]["reasoning_log"] == []


def test_all_walkthroughs_finish_without_network_calls_or_training_memory(client, monkeypatch):
    monkeypatch.delenv("CORP_STUB_WORKERS", raising=False)
    monkeypatch.delenv("CORP_DISABLE_LLM_JUDGE", raising=False)
    with patch("server.environment.call_worker_model", side_effect=AssertionError("Live worker called")), \
         patch("server.reward.call_llm_judge", side_effect=AssertionError("Live judge called")), \
         patch("server.environment.append_master_episode", side_effect=AssertionError("Training memory written")), \
         patch("server.environment.append_worker_episode", side_effect=AssertionError("Training memory written")):
        for task in client.get("/ui/scenarios").json()["scenarios"]:
            session = client.post("/ui/sessions", json={"task_id": task["id"]}).json()
            session_id = session["session_id"]
            for action in task["example_actions"]:
                response = client.post(f"/ui/sessions/{session_id}/step", json=action)
                assert response.status_code == 200, response.text
                session = response.json()
                assert not session["observation"]["error"]
            assert session["observation"]["done"]
            assert session["demo_mode"]
            assert all(session["verification"].values()), session["verification"]
            assert len(session["history"]) == len(task["example_actions"])
            assert client.post(f"/ui/sessions/{session_id}/step", json={
                "action_type": "log_reasoning", "payload": "Too late"
            }).status_code == 409


def test_reset_reclaims_session_and_unknown_inputs_are_rejected(client):
    first = client.post("/ui/sessions", json={}).json()
    second = client.post("/ui/sessions", json={"previous_session_id": first["session_id"]})
    assert second.status_code == 201
    assert client.get(f"/ui/sessions/{first['session_id']}").status_code == 404
    assert client.post("/ui/sessions", json={"task_id": "unknown"}).status_code == 422
    assert client.get("/ui/sessions/unknown").status_code == 404
    session_id = second.json()["session_id"]
    assert client.post(f"/ui/sessions/{session_id}/step", json={
        "action_type": "invalid"
    }).status_code == 422
    assert client.post(f"/ui/sessions/{session_id}/step", json={
        "action_type": "log_reasoning", "payload": "x" * 16001
    }).status_code == 422


def test_sessions_expire_and_capacity_is_bounded(client, monkeypatch):
    monkeypatch.setattr("server.dashboard.MAX_SESSIONS", 1)
    first = client.post("/ui/sessions", json={}).json()
    assert client.post("/ui/sessions", json={}).status_code == 429
    monkeypatch.setattr("server.dashboard.SESSION_TTL", -1)
    assert client.get(f"/ui/sessions/{first['session_id']}").status_code == 404
    assert client.post("/ui/sessions", json={}).status_code == 201
