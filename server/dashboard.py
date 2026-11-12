"""Browser dashboard with bounded, isolated demo environments.

OpenEnv's training endpoints and original /web playground stay intact. Public
dashboard sessions use deterministic workers, never call paid models, and never
write into the training environment's cross-episode memory.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
import json
from pathlib import Path
from threading import Lock
from time import monotonic
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from corp_env.models import CorpAction, CorpObservation
from server.environment import CorpEnvironment
from server.reward import compute_swd_coherence
from server.tasks import TASKS

STATIC_DIR = Path(__file__).with_name("static")
WALKTHROUGHS = json.loads((STATIC_DIR / "walkthroughs.json").read_text(encoding="utf-8"))
SESSION_TTL = 3600
MAX_SESSIONS = 32
TASK_TITLES = {
    "e1_launch_readiness": ("Launch readiness", "A launch in 48 hours. One critical quality gate."),
    "m1_budget_reallocation": ("Budget reallocation", "Big compute ambitions. A very real budget."),
    "h1_acquisition_defence": ("Acquisition defence", "Three advisors. Conflicting intel. Your call."),
}


class NewSession(BaseModel):
    task_id: str = Field(default="e1_launch_readiness", max_length=80)
    previous_session_id: str | None = Field(default=None, max_length=40)


@dataclass
class DemoSession:
    env: CorpEnvironment
    observation: CorpObservation
    touched: float = field(default_factory=monotonic)
    total_reward: float = 0.0
    history: list[dict[str, Any]] = field(default_factory=list)
    lock: Any = field(default_factory=Lock)


def mount_dashboard(app: FastAPI) -> None:
    router = APIRouter(prefix="/ui", tags=["Dashboard"])
    sessions: dict[str, DemoSession] = {}
    registry_lock = Lock()

    def session_for(session_id: str) -> DemoSession:
        with registry_lock:
            session = sessions.get(session_id)
            if session is None or monotonic() - session.touched > SESSION_TTL:
                sessions.pop(session_id, None)
                raise HTTPException(404, "Session expired. Start a new episode to continue.")
            session.touched = monotonic()
            return session

    def snapshot(session_id: str, session: DemoSession) -> dict[str, Any]:
        return {
            "session_id": session_id,
            "demo_mode": True,
            "observation": session.observation.model_dump(mode="json"),
            "total_reward": session.total_reward,
            "coherence": compute_swd_coherence(session.observation.swd),
            "verification": session.env.task.verifier(session.observation.swd),
            "history": session.history,
        }

    @router.get("/scenarios")
    def scenarios() -> dict[str, Any]:
        return {"scenarios": [
            {
                "id": task_id,
                "title": TASK_TITLES[task_id][0],
                "summary": TASK_TITLES[task_id][1],
                "description": task.description,
                "difficulty": task.difficulty,
                "role": task.role,
                "token_budget": task.token_budget,
                "agents": [asdict(slot) for slot in task.agent_slots],
                "example_actions": WALKTHROUGHS[task_id],
            }
            for task_id, task in TASKS.items()
        ]}

    @router.post("/sessions", status_code=201)
    def new_session(request: NewSession) -> dict[str, Any]:
        if request.task_id not in TASKS:
            raise HTTPException(422, "Unknown scenario.")
        with registry_lock:
            now = monotonic()
            for session_id in list(sessions):
                if now - sessions[session_id].touched > SESSION_TTL:
                    sessions.pop(session_id).env.close()
            if request.previous_session_id in sessions:
                sessions.pop(request.previous_session_id).env.close()
            if len(sessions) >= MAX_SESSIONS:
                raise HTTPException(429, "The demo is busy. Please try again in a few minutes.")
            env = CorpEnvironment(demo_mode=True)
            session = DemoSession(env=env, observation=env.reset(task_id=request.task_id))
            session_id = str(uuid4())
            sessions[session_id] = session
        return snapshot(session_id, session)

    @router.get("/sessions/{session_id}")
    def get_session(session_id: str) -> dict[str, Any]:
        session = session_for(session_id)
        with session.lock:
            return snapshot(session_id, session)

    @router.post("/sessions/{session_id}/step")
    def step(session_id: str, action: CorpAction) -> dict[str, Any]:
        if len(action.payload) > 16000:
            raise HTTPException(422, "Action payload must be 16,000 characters or fewer.")
        session = session_for(session_id)
        with session.lock:
            if session.observation.done:
                raise HTTPException(409, "This episode is complete. Start a new episode.")
            session.observation = session.env.step(action)
            session.total_reward += float(session.observation.reward or 0)
            session.history.append({
                "turn": session.observation.turn,
                "action": action.model_dump(mode="json"),
                "reward": session.observation.reward,
                "error": session.observation.error,
                "output": session.observation.agent_last_output,
            })
            return snapshot(session_id, session)

    # The OpenEnv factory registers a root redirect before application routes.
    # Replace that route so the Space opens directly into the custom dashboard.
    app.router.routes[:] = [r for r in app.router.routes if getattr(r, "path", None) != "/"]

    @app.get("/", include_in_schema=False)
    def dashboard() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})

    app.include_router(router)
    app.mount("/assets", StaticFiles(directory=STATIC_DIR), name="dashboard-assets")
