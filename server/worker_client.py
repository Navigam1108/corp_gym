"""Call frozen worker LLMs (or deterministic stubs for CI / offline).

Workers are (family, tier) personas attached to a task slot. The task prompt
comes from the master each turn; prior episode summaries and prior turns from
the current episode are injected as memory so the sub-agent is "agentic".
"""

from __future__ import annotations

import os
from typing import List, Optional

from openai import OpenAI

from server.agents.personas import AgentSlot, render_worker_system
from server.llm_env import openai_client_kwargs_worker, worker_model_for
from server.memory import (
    append_worker_turn,
    format_past_experience_block,
    load_episode_turns,
    load_recent_worker_memory,
)


# Deterministic stub outputs keyed by FAMILY (task-agnostic).
_STUB_OUTPUTS = {
    "qa": (
        "TEST_SUMMARY: unit=382/390 pass, integration=72/80 pass, e2e=19/25 pass. "
        "PASS_FAIL_METRIC: 473/495 passed (95.56%), 22 failed. "
        "FLAKY_TESTS: 4 unstable tests in notification and retry paths. "
        "BLOCKERS: 2 deterministic failures in payment rollback and migration smoke test. "
        "LAUNCH_GATE: FAIL until blockers are patched and e2e pass rate exceeds 98%."
    ),
    "dev": (
        "Engineering readout: feature branch merged, canary healthy, load tests within SLO. "
        "Residual risk: third-party API quota - mitigation: cache + backoff."
    ),
    "hr": (
        "HR sign-off: on-call roster staffed for the target window; contingent workers briefed. "
        "Policy check: overtime pre-approved for the T-48h window only."
    ),
    "finance": (
        "Finance: launch opex within Q envelope; contingency fund intact. "
        "ROI breakeven projected at 10 weeks post-launch under base case."
    ),
    "strategy": (
        "Strategy: recommend phased execution; track competitor response at weeks 2 and 6."
    ),
}


def _is_stub_mode() -> bool:
    return os.getenv("CORP_STUB_WORKERS", "").lower() in ("1", "true", "yes")


def call_model_stub(
    slot: AgentSlot, task_description: str, *, task_id: Optional[str] = None
) -> str:
    demo_reports = {
        "m1_budget_reallocation": {
            "dev": "ENGINEERING ASSESSMENT: GPU cluster access is the bottleneck for the next training milestone. Prioritize the highest-value experiment and start with a constrained compute block. Expand only after measuring utilization and throughput. TRADE-OFF: a smaller allocation delays parallel experiments, but protects the essential training run.",
            "finance": "FINANCE ASSESSMENT: The compute plan must stay within the approved budget and preserve cash runway. A large upfront GPU commitment increases burn before results are demonstrated. RECOMMENDATION: cap phase-one spend, review utilization and costs weekly, and require finance approval before expanding capacity.",
        },
        "h1_acquisition_defence": {
            "dev": "CTO ASSESSMENT: Our stack is approximately 18 months ahead; the acquirer cannot replicate the technical moat quickly. An opening counter around 3.5x valuation recognizes this leverage. RISK: an extended IP lock-up limits our future options, and a prolonged process may erode the team that creates the moat.",
            "finance": "CFO ASSESSMENT: Cash runway is approximately seven months at the current burn rate. The board is unlikely to support a 3.5x ask; around 2.6x is the realistic ceiling without new financing. RECOMMENDATION: keep negotiations time-bound and acknowledge cash constraints in the counter-offer.",
            "hr": "CHRO ASSESSMENT: Key engineers have competing offers. Retention risk reaches approximately 60% if the process exceeds 90 days without incentives. RECOMMENDATION: commit to a near-term deadline, communicate role continuity, and put retention incentives in place before uncertainty drives departures.",
        },
    }
    base = demo_reports.get(task_id, {}).get(slot.family) or _STUB_OUTPUTS.get(
        slot.family,
        f"{slot.title} acknowledges: {task_description[:200]}",
    )
    if task_description:
        return f"{base}\n\n(Task focus: {task_description[:400]})"
    return base


def _build_memory_prefix(task_id: str, slot_id: str) -> str:
    recent = load_recent_worker_memory(task_id, slot_id, n_episodes=3)
    return format_past_experience_block(recent)


def _build_prior_turn_messages(
    task_id: str, slot_id: str, episode_id: str
) -> List[dict]:
    prior = load_episode_turns(task_id, slot_id, episode_id)
    msgs: List[dict] = []
    for row in prior:
        up = str(row.get("user_prompt", "")).strip()
        resp = str(row.get("response", "")).strip()
        if up:
            msgs.append({"role": "user", "content": up})
        if resp:
            msgs.append({"role": "assistant", "content": resp})
    # Keep chat history bounded to avoid context blow-up in long episodes.
    if len(msgs) > 10:
        msgs = msgs[-10:]
    return msgs


def call_worker_model(
    slot: AgentSlot,
    task_description: str,
    *,
    task_id: str,
    episode_id: str,
    turn: int,
    max_tokens: int = 400,
) -> str:
    """Synchronous worker call with cross-episode memory + per-episode replay.

    ``slot`` carries the family / tier / title used to render the persona
    system prompt. Each call appends one row to the worker's ``turns.jsonl``
    so subsequent delegations to the same slot within the same episode see
    the prior exchange.
    """
    if _is_stub_mode():
        out = call_model_stub(slot, task_description)
        append_worker_turn(
            task_id=task_id,
            slot_id=slot.id,
            episode_id=episode_id,
            turn=turn,
            user_prompt=task_description,
            response=out,
        )
        return out

    kwargs = openai_client_kwargs_worker(slot.family + "_agent")
    if not kwargs.get("api_key"):
        out = call_model_stub(slot, task_description)
        append_worker_turn(
            task_id=task_id,
            slot_id=slot.id,
            episode_id=episode_id,
            turn=turn,
            user_prompt=task_description,
            response=out,
        )
        return out

    system = render_worker_system(slot)
    memory_prefix = _build_memory_prefix(task_id, slot.id)
    if memory_prefix:
        system = f"{system}\n\n{memory_prefix}"

    model = worker_model_for(slot.family + "_agent")
    client = OpenAI(**kwargs)

    messages: List[dict] = [{"role": "system", "content": system}]
    messages.extend(_build_prior_turn_messages(task_id, slot.id, episode_id))
    messages.append({"role": "user", "content": task_description})

    resp = client.chat.completions.create(
        model=model,
        messages=messages,
        max_tokens=max_tokens,
        temperature=0.3,
    )
    out = (resp.choices[0].message.content or "").strip()
    append_worker_turn(
        task_id=task_id,
        slot_id=slot.id,
        episode_id=episode_id,
        turn=turn,
        user_prompt=task_description,
        response=out,
    )
    return out
