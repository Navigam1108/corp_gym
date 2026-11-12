/* The dashboard uses its own per-browser demo session, separate from OpenEnv. */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const icon = (name, classes = "") =>
    `<svg class="icon ${classes}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
  const pretty = (value) =>
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const title = (value) =>
    String(value)
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const number = (value, digits = 3) => Number(value || 0).toFixed(digits);
  const state = {
    scenarios: [],
    taskId: "e1_launch_readiness",
    session: null,
    tab: "overview",
    busy: false,
    walking: false,
    stop: false,
    actionTypes: [],
    toastTimer: null,
  };
  const actionNames = {
    delegate: "Consult an advisor",
    log_reasoning: "Log reasoning",
    log_decision: "Log a decision",
    log_conflict: "Identify a conflict",
    log_resolution: "Resolve a conflict",
    advance_phase: "Advance phase",
    query_swd: "Query workspace",
    update_swd: "Edit workspace",
    finalize: "Finalize recommendation",
  };
  const helps = {
    delegate: "The advisor's report will be added to your workspace.",
    log_reasoning: "Record the evidence and trade-offs behind your thinking.",
    log_decision: "Add a decision to the shared decision log.",
    log_conflict:
      "Describe a conflict, or use a JSON object with id, summary, and source_agents.",
    log_resolution:
      "Use a JSON object with conflict_id, resolution_type, and text.",
    advance_phase: "Move your workspace from discovery through execution.",
    query_swd: "Enter a JSONPath expression, for example $.agent_reports.",
    update_swd:
      "Enter an RFC 6902 JSON Patch array. Changes are validated by the environment.",
    finalize:
      "Ends the episode and evaluates your recommendation. Use GO / NO_GO for E1, or a JSON plan for M1 / H1.",
  };
  const scenario = () =>
    state.scenarios.find((task) => task.id === state.taskId);
  const obs = () => state.session?.observation;

  async function api(path, body) {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(
        "The environment returned an unexpected response. Please try again.",
      );
    }
    if (!response.ok) {
      const error = new Error(
        typeof data.detail === "string"
          ? data.detail
          : "The action could not be processed. Check your input and try again.",
      );
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message, error = false) {
    clearTimeout(state.toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    state.toastTimer = setTimeout(
      () => {
        $("toast").hidden = true;
      },
      error ? 7500 : 4000,
    );
  }

  function rememberSession() {
    try {
      sessionStorage.setItem(
        "corp-env-session",
        JSON.stringify({
          taskId: state.taskId,
          sessionId: state.session.session_id,
        }),
      );
    } catch {
      /* Storage is optional. */
    }
  }

  function controls() {
    const disabled = state.busy || state.walking || !state.session;
    $("reset-button").disabled = disabled;
    $("walkthrough-button").disabled =
      (state.busy && !state.walking) || !state.session;
    $("walkthrough-button").innerHTML = state.walking
      ? "<span>Pause walkthrough</span>"
      : `${icon("play")}<span>Run walkthrough</span>`;
    $("submit-button").disabled = disabled || Boolean(obs()?.done);
    $("submit-button").innerHTML = state.busy
      ? `<span>Processing…</span>${icon("reset", "spinning")}`
      : `<span>${obs()?.done ? "Episode complete" : "Send action"}</span>${icon("arrow")}`;
    $("export-button").disabled = !state.session;
    document.querySelectorAll(".scenario-card").forEach((card) => {
      card.disabled = disabled;
    });
    for (const id of [
      "action-type",
      "agent-id",
      "phase-select",
      "action-payload",
      "example-button",
    ])
      $(id).disabled = disabled || Boolean(obs()?.done);
  }

  function renderScenarios() {
    const icons = ["launch", "wallet", "shield"];
    $("scenario-cards").innerHTML = state.scenarios
      .map(
        (task, i) =>
          `<button class="scenario-card ${task.id === state.taskId ? "selected" : ""}" data-scenario="${esc(task.id)}" aria-pressed="${task.id === state.taskId}"><div class="scenario-top"><span class="scenario-icon">${icon(icons[i])}</span><span class="difficulty ${esc(task.difficulty)}">${esc(title(task.difficulty))}</span></div><h3>${esc(task.title)}</h3><p>${esc(task.summary)}</p><div class="scenario-footer"><span>${task.id.slice(0, 2).toUpperCase()} · ${task.agents.length} advisor${task.agents.length > 1 ? "s" : ""} · ${(task.token_budget / 1024).toFixed(0)}k tokens</span>${task.id === state.taskId ? `<span class="selected-check">${icon("check")}</span>` : icon("arrow")}</div></button>`,
      )
      .join("");
    document.querySelectorAll("[data-scenario]").forEach((button) =>
      button.addEventListener("click", () => {
        if (button.dataset.scenario !== state.taskId)
          startEpisode(button.dataset.scenario).catch(handleError);
      }),
    );
  }

  function renderMetrics() {
    const o = obs();
    if (!o) return;
    const complete = o.swd.milestones.filter(
      (m) => m.status === "complete",
    ).length;
    const tokens = Math.min(100, (o.tokens_used / o.token_budget) * 100);
    $("metrics").innerHTML =
      `<div class="metric"><div class="metric-label">Episode status <span>↗</span></div><div class="metric-value status">${o.done ? "Completed" : o.turn ? "In progress" : "Ready to begin"}</div><div class="metric-sub">${complete} of ${o.swd.milestones.length} milestones complete</div></div><div class="metric"><div class="metric-label">Current turn <span>⌁</span></div><div class="metric-value">${o.turn.toString().padStart(2, "0")}<small>/ 256 max</small></div><div class="metric-sub">Every action moves the episode forward</div></div><div class="metric"><div class="metric-label">${o.done ? "Final step reward" : "Last step reward"} <span>↗</span></div><div class="metric-value">${number(o.reward)}<small>reward</small></div><div class="metric-sub">${number(state.session.total_reward)} cumulative episode reward</div></div><div class="metric"><div class="metric-label">Token budget <span>◫</span></div><div class="metric-value">${o.tokens_used.toLocaleString()}<small>/ ${o.token_budget.toLocaleString()}</small></div><div class="token-track"><span style="width:${tokens}%"></span></div></div>`;
  }

  function renderMilestones() {
    const milestones = obs().swd.milestones;
    $("milestone-count").textContent =
      `${milestones.filter((m) => m.status === "complete").length} / ${milestones.length}`;
    $("milestones").innerHTML = milestones
      .map(
        (m, i) =>
          `<div class="milestone ${esc(m.status)}"><span class="milestone-marker">${m.status === "complete" ? "✓" : m.status === "missed" ? "!" : i + 1}</span><div class="milestone-content">${esc(m.label)}<span>${m.status === "complete" ? "Complete" : m.status === "missed" ? "Deadline missed" : `Due by turn ${m.due_by_turn}`}</span></div></div>`,
      )
      .join("");
  }

  function emptyWorkspace(heading, message, shortcut = false) {
    return `<div class="empty-workspace"><div class="workspace-diagram"><span class="diagram-node">${icon("users")}</span><span class="diagram-line"></span><span class="diagram-node central">${icon("file")}</span><span class="diagram-line"></span><span class="diagram-node">${icon("check")}</span></div><h3>${esc(heading)}</h3><p>${esc(message)}</p>${shortcut ? '<button class="text-button" id="first-action">Start with an advisor consultation →</button>' : ""}</div>`;
  }

  function renderOverview() {
    const o = obs(),
      swd = o.swd;
    if (!o.turn)
      return emptyWorkspace(
        "A fresh workspace. A decision to make.",
        "Your advisors, reasoning, and recommendations will come together here. Start by gathering evidence.",
        true,
      );
    const reports = Object.values(swd.agent_reports).filter(Boolean).length;
    let html = `<div class="overview-summary"><div class="summary-item"><strong>${reports}</strong><span>Advisor report${reports !== 1 ? "s" : ""}</span></div><div class="summary-item"><strong>${swd.reasoning_log.length}</strong><span>Reasoning notes</span></div><div class="summary-item"><strong>${swd.conflict_resolutions.length} <span style="display:inline;font-size:10px">/ ${swd.conflicts_identified.length}</span></strong><span>Conflicts resolved</span></div></div>`;
    if (swd.final_recommendation !== null)
      html += `<div class="recommendation"><h3>Final recommendation</h3><pre>${esc(pretty(swd.final_recommendation))}</pre></div>`;
    const groups = [
      ["Reasoning", swd.reasoning_log, "text"],
      ["Decisions", swd.decisions, "summary"],
      ["Conflicts", swd.conflicts_identified, "summary"],
      ["Resolutions", swd.conflict_resolutions, "text"],
    ];
    for (const [label, entries, key] of groups)
      if (entries.length)
        html += `<div class="entry-label">${label}</div>${entries.map((entry) => `<div class="log-entry"><span class="entry-turn">${entry.turn ? `TURN ${entry.turn}` : esc(entry.id || entry.conflict_id || "")}</span>${esc(entry[key] ?? pretty(entry))}</div>`).join("")}`;
    if (!groups.some(([, entries]) => entries.length) && !o.done)
      html +=
        '<div class="log-entry">Evidence is coming in. Review your advisor reports, then record your reasoning and decisions.</div>';
    if (o.query_result !== null && o.query_result !== undefined)
      html += `<div class="query-result"><span class="mini-label">QUERY RESULT</span><pre>${esc(pretty(o.query_result))}</pre></div>`;
    if (o.done)
      html += `<div class="verification"><h3>Verifier results · ${Object.values(state.session.verification).filter(Boolean).length} / ${Object.keys(state.session.verification).length} passed</h3>${Object.entries(
        state.session.verification,
      )
        .map(
          ([key, passed]) =>
            `<div class="verification-item ${passed ? "" : "failed"}"><span>${passed ? "✓" : "○"}</span><span>${esc(title(key))}</span></div>`,
        )
        .join("")}</div>`;
    return html;
  }

  function renderReports() {
    return scenario()
      .agents.map((agent) => {
        const report = obs().swd.agent_reports[agent.family];
        return `<article class="report-card ${report ? "" : "waiting-report"}"><div class="report-heading"><span class="avatar">${esc(
          agent.id
            .split("_")
            .map((w) => w[0])
            .join("")
            .slice(0, 2)
            .toUpperCase(),
        )}</span><div><h3>${esc(agent.title)}</h3><small>${esc(title(agent.family))} · ${esc(title(agent.tier))}</small></div><span class="report-status">${report ? "✓ Received" : "Awaiting consultation"}</span></div><div class="report-body">${report ? esc(report) : "Consult this advisor to add their perspective to the workspace."}</div></article>`;
      })
      .join("");
  }

  function renderActivity() {
    if (!state.session.history.length)
      return emptyWorkspace(
        "Every move leaves a trace.",
        "Actions, advisor consultations, and rewards will appear here as your episode progresses.",
      );
    return [...state.session.history]
      .reverse()
      .map(
        (entry) =>
          `<div class="activity-row"><span class="activity-marker">${entry.turn}</span><div class="activity-text"><strong>${esc(actionNames[entry.action.action_type] || entry.action.action_type)}${entry.action.agent_id ? ` · ${esc(title(entry.action.agent_id))}` : ""}</strong><p>${esc(entry.action.payload)}</p>${entry.error ? `<p class="activity-error">${esc(entry.error)}</p>` : ""}</div><span class="activity-reward">${Number(entry.reward) >= 0 ? "+" : ""}${number(entry.reward)}</span></div>`,
      )
      .join("");
  }

  function renderContent() {
    if (!state.session) return;
    $("workspace-content").setAttribute("aria-labelledby", `tab-${state.tab}`);
    $("workspace-content").innerHTML =
      state.tab === "overview"
        ? renderOverview()
        : state.tab === "reports"
          ? renderReports()
          : state.tab === "activity"
            ? renderActivity()
            : `<div class="json-toolbar"><span>Shared Workspace Document · SWD</span><button class="text-button" id="copy-json">${icon("copy")} Copy JSON</button></div><pre class="json-view">${esc(JSON.stringify(obs().swd, null, 2))}</pre>`;
    $("first-action")?.addEventListener("click", () => {
      $("action-type").value = "delegate";
      configureAction();
      $("action-payload").focus();
    });
    $("copy-json")?.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(JSON.stringify(obs().swd, null, 2));
        toast("Workspace JSON copied.");
      } catch {
        toast(
          "Clipboard unavailable. Use the download button to save your episode.",
          true,
        );
      }
    });
  }

  function render() {
    if (!state.session) return;
    const o = obs();
    $("episode-label").textContent =
      `EPISODE / ${state.session.session_id.slice(0, 8).toUpperCase()}`;
    $("scenario-description").textContent = o.task_description;
    $("role-badge").textContent = o.role;
    $("version-label").textContent = `v${o.swd.swd_version}`;
    $("reports-count").textContent = Object.values(o.swd.agent_reports).filter(
      Boolean,
    ).length;
    $("activity-count").textContent = state.session.history.length;
    $("next-step-hint").textContent = o.done
      ? "Episode complete. Review the verifier results or start a new episode."
      : o.next_step_hint;
    const phases = ["discovery", "analysis", "decision", "execution"],
      phaseIndex = phases.indexOf(o.swd.phase);
    $("phase-track").innerHTML = phases
      .map(
        (phase, i) =>
          `<div class="phase-step ${i === phaseIndex ? "current" : i < phaseIndex ? "past" : ""}" ${i === phaseIndex ? 'aria-current="step"' : ""}><span class="phase-number">${i < phaseIndex ? "✓" : `0${i + 1}`}</span>${title(phase)}</div>`,
      )
      .join("");
    renderMetrics();
    renderMilestones();
    renderContent();
    controls();
    $("connection-dot").classList.add("online");
    $("connection-text").textContent = "Environment connected";
  }

  function configureAction(useExample = true) {
    const action = $("action-type").value;
    $("advisor-field").hidden = action !== "delegate";
    $("phase-field").hidden = action !== "advance_phase";
    $("payload-field").hidden = action === "advance_phase";
    $("action-payload").required = action !== "advance_phase";
    $("action-help").textContent = helps[action];
    $("payload-label").textContent =
      action === "delegate"
        ? "Your request"
        : action === "query_swd"
          ? "JSONPath expression"
          : [
                "log_conflict",
                "log_resolution",
                "update_swd",
                "finalize",
              ].includes(action)
            ? "Payload"
            : "Your note";
    if (useExample) fillExample();
  }

  function fillExample() {
    const task = scenario();
    if (!task) return;
    const action = $("action-type").value;
    const examples = task.example_actions;
    const match = examples.find(
      (item) =>
        item.action_type === action &&
        (action !== "delegate" || item.agent_id === $("agent-id").value),
    );
    const fallback = {
      log_reasoning:
        "Weigh the advisor evidence against the scenario constraints before committing.",
      log_decision:
        "Prioritize the evidence-backed option and document the trade-offs.",
      log_conflict: JSON.stringify(
        {
          id: "c1",
          summary: "Describe the competing requirements.",
          source_agents: task.agents.map((a) => a.id),
        },
        null,
        2,
      ),
      log_resolution: JSON.stringify(
        {
          conflict_id: "c1",
          resolution_type: "compromise",
          text: "Explain how the plan addresses the competing requirements.",
        },
        null,
        2,
      ),
      query_swd: "$.agent_reports",
      update_swd: JSON.stringify(
        [{ op: "replace", path: "/phase", value: "analysis" }],
        null,
        2,
      ),
    };
    $("action-payload").value =
      match?.payload ||
      fallback[action] ||
      "Provide your assessment of the scenario, key risks, and constraints.";
    if (action === "advance_phase") {
      const phases = ["discovery", "analysis", "decision", "execution"];
      const current = phases.indexOf(obs()?.swd.phase || "discovery");
      $("phase-select").value = phases[Math.min(current + 1, 3)];
    }
  }

  async function startEpisode(taskId = state.taskId) {
    if (state.busy || state.walking) return;
    state.busy = true;
    controls();
    try {
      const nextSession = await api("/ui/sessions", {
        task_id: taskId,
        previous_session_id: state.session?.session_id || null,
      });
      state.taskId = taskId;
      state.session = nextSession;
      $("agent-id").innerHTML = scenario()
        .agents.map(
          (agent) =>
            `<option value="${esc(agent.id)}">${esc(agent.title)}</option>`,
        )
        .join("");
      $("action-type").value = "delegate";
      configureAction();
      state.tab = "overview";
      syncTabs();
      rememberSession();
      renderScenarios();
      render();
    } finally {
      state.busy = false;
      controls();
    }
  }

  async function sendAction(action) {
    const nextSession = await api(
      `/ui/sessions/${state.session.session_id}/step`,
      action,
    );
    state.session = nextSession;
    render();
    if (obs().error) toast(obs().error, true);
    else if (obs().done)
      toast("Episode complete. Your recommendation has been evaluated.");
    return nextSession;
  }

  function handleError(error) {
    toast(
      error.message || "Could not reach the environment. Please try again.",
      true,
    );
    if (error.status === 404) {
      state.session = null;
      controls();
      $("reset-button").disabled = false;
    }
  }

  async function walkthrough() {
    if (state.walking) {
      state.stop = true;
      return;
    }
    if (state.busy) return;
    await startEpisode();
    state.walking = true;
    state.stop = false;
    controls();
    try {
      for (const action of scenario().example_actions) {
        if (state.stop || obs().done) break;
        $("action-type").value = action.action_type;
        if (action.agent_id) $("agent-id").value = action.agent_id;
        configureAction(false);
        $("action-payload").value = action.payload;
        if (action.action_type === "advance_phase")
          $("phase-select").value = action.payload;
        await sendAction(action);
        if (!obs().done)
          await new Promise((resolve) => setTimeout(resolve, 550));
      }
      if (state.stop && !obs().done)
        toast(
          "Walkthrough paused. Continue with your own actions, or restart the walkthrough.",
        );
    } finally {
      state.walking = false;
      controls();
    }
  }

  function syncTabs() {
    document.querySelectorAll("[data-tab]").forEach((button) => {
      const active = button.dataset.tab === state.tab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", active);
      button.tabIndex = active ? 0 : -1;
    });
  }

  function switchTab(tab) {
    state.tab = tab;
    syncTabs();
    renderContent();
  }
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
    button.addEventListener("keydown", (event) => {
      const tabs = ["overview", "reports", "activity", "json"];
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      const current = tabs.indexOf(state.tab);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? 3
            : (current + (event.key === "ArrowRight" ? 1 : -1) + 4) % 4;
      switchTab(tabs[next]);
      $(`tab-${tabs[next]}`).focus();
    });
  });

  document.querySelectorAll("[data-view]").forEach((button) =>
    button.addEventListener("click", () => {
      const view = button.dataset.view;
      document
        .querySelectorAll("[data-view]")
        .forEach((nav) => nav.classList.toggle("active", nav === button));
      $("workspace-view").hidden = view !== "workspace";
      $("benchmarks-view").hidden = view !== "benchmarks";
      $("breadcrumb-current").textContent = title(view);
      document.title = `CORP-ENV · ${view === "workspace" ? "Decision workspace" : "Benchmarks"}`;
    }),
  );
  $("reset-button").addEventListener("click", () =>
    startEpisode().catch(handleError),
  );
  $("walkthrough-button").addEventListener("click", () =>
    walkthrough().catch(handleError),
  );
  $("action-type").addEventListener("change", () => configureAction());
  $("agent-id").addEventListener("change", fillExample);
  $("example-button").addEventListener("click", fillExample);
  $("action-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.busy || state.walking || !state.session || obs().done) return;
    const action = $("action-type").value;
    const payload =
      action === "advance_phase"
        ? $("phase-select").value
        : $("action-payload").value.trim();
    if (!payload) {
      toast("Enter a request or note before sending your action.", true);
      return;
    }
    if (
      ["update_swd", "log_resolution"].includes(action) ||
      payload.startsWith("{") ||
      payload.startsWith("[")
    ) {
      try {
        JSON.parse(payload);
      } catch {
        toast(
          "The payload contains invalid JSON. Check the syntax before sending.",
          true,
        );
        return;
      }
    }
    state.busy = true;
    controls();
    try {
      await sendAction({
        action_type: action,
        agent_id: action === "delegate" ? $("agent-id").value : null,
        payload,
      });
    } catch (error) {
      handleError(error);
    } finally {
      state.busy = false;
      controls();
      if (!obs()?.done) fillExample();
    }
  });
  $("export-button").addEventListener("click", () => {
    if (!state.session) return;
    const url = URL.createObjectURL(
      new Blob(
        [JSON.stringify({ scenario: state.taskId, ...state.session }, null, 2)],
        { type: "application/json" },
      ),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `corp-env-${state.taskId}-${state.session.session_id.slice(0, 8)}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  async function loadBenchmarks() {
    const response = await fetch("/assets/benchmarks.json");
    if (!response.ok)
      throw new Error("Could not load saved benchmark results.");
    const data = await response.json();
    const stages = ["Base", "SFT", "RLVR"];
    $("benchmark-charts").innerHTML = state.scenarios
      .map(
        (task) =>
          `<section class="panel benchmark-card"><h2>${esc(task.title)}</h2><p>Average terminal reward · 5 episodes per stage</p>${stages
            .map((stage) => {
              const row = data.find(
                (item) => item.task_id === task.id && item.stage === stage,
              );
              return `<div class="chart-row ${stage.toLowerCase()}"><div><span>${stage}</span><strong>${number(row.avg_terminal_reward)}</strong></div><div class="chart-track" role="img" aria-label="${esc(stage)} average terminal reward ${number(row.avg_terminal_reward)} out of 1"><span style="width:${row.avg_terminal_reward * 100}%"></span></div></div>`;
            })
            .join("")}</section>`,
      )
      .join("");
    $("benchmark-table").innerHTML = state.scenarios
      .flatMap((task) =>
        stages.map((stage) => {
          const row = data.find(
            (item) => item.task_id === task.id && item.stage === stage,
          );
          return `<tr><td>${esc(task.title)}</td><td><span class="stage-pill">${stage}</span></td><td>${number(row.avg_terminal_reward)}</td><td>${number(row.avg_verifier_pass_rate * 100, 1)}%</td><td>${number(row.success_rate * 100, 0)}%</td><td>${number(row.avg_invalid_action_rate * 100, 1)}%</td></tr>`;
        }),
      )
      .join("");
  }

  async function boot() {
    controls();
    try {
      const data = await api("/ui/scenarios");
      state.scenarios = data.scenarios;
      let saved;
      try {
        saved = JSON.parse(sessionStorage.getItem("corp-env-session"));
      } catch {
        /* Start fresh. */
      }
      if (
        saved?.sessionId &&
        state.scenarios.some((task) => task.id === saved.taskId)
      ) {
        try {
          state.session = await api(`/ui/sessions/${saved.sessionId}`);
          state.taskId = saved.taskId;
          $("agent-id").innerHTML = scenario()
            .agents.map(
              (agent) =>
                `<option value="${esc(agent.id)}">${esc(agent.title)}</option>`,
            )
            .join("");
          configureAction();
          renderScenarios();
          render();
        } catch (error) {
          if (error.status !== 404) throw error;
        }
      }
      if (!state.session) await startEpisode();
      loadBenchmarks().catch((error) => {
        $("benchmark-charts").innerHTML =
          `<div class="loading-placeholder">${esc(error.message)}</div>`;
      });
    } catch (error) {
      $("connection-text").textContent = "Connection unavailable";
      $("scenario-cards").innerHTML =
        '<div class="loading-placeholder">The environment could not be reached. Reload the page to reconnect.</div>';
      handleError(error);
    }
  }
  boot();
})();
