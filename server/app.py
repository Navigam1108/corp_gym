"""FastAPI entrypoint for CORP-ENV (OpenEnv HTTP server + web playground)."""

from __future__ import annotations

import os

import uvicorn
from openenv.core.env_server import create_web_interface_app

from corp_env.models import CorpAction, CorpObservation
from server.dashboard import mount_dashboard
from server.environment import CorpEnvironment

app = create_web_interface_app(
    CorpEnvironment,
    CorpAction,
    CorpObservation,
    env_name="corp-env",
    max_concurrent_envs=4,
)


mount_dashboard(app)


def main() -> None:
    port = int(os.environ.get("PORT", "7860"))
    uvicorn.run("server.app:app", host="0.0.0.0", port=port)


if __name__ == "__main__":
    main()
