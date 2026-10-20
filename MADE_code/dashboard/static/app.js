const phaseLabels = {
  repoingest: "RepoIngest",
  weightresolve: "WeightResolve",
  dockersetup: "DockerSetUp",
  apiadaptation: "APIAdaptation",
  servicedelivery: "ServiceDelivery",
};

const phaseRank = { repoingest: 0, weightresolve: 1, dockersetup: 1, apiadaptation: 2, servicedelivery: 3 };
const phaseOrder = Object.keys(phaseLabels);
let selectedRunId = new URLSearchParams(window.location.search).get("run") || null;
let dashboardData = null;
let liveEvents = null;
const expandedRows = { trigger: new Set(), artifact: new Set() };
let tokenFrame = null;
let tokenTarget = null;
let loadedRunId = null;

function flash(element, className = "is-feedback") {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}

function setDuration(seconds, animate = true) {
  const element = document.getElementById("run-duration");
  const value = seconds === null ? "—" : formatDuration(seconds);
  if (element.textContent === value) return;
  element.textContent = value;
  if (animate) flash(element, "is-updated");
}

function setTokenCount(value, animate = true) {
  const total = Math.max(0, Number(value) || 0);
  const element = document.getElementById("run-tokens");
  if (tokenTarget === total) return;
  cancelAnimationFrame(tokenFrame);
  const previous = Number(element.dataset.value) || 0;
  tokenTarget = total;
  const finish = () => {
    element.setAttribute("aria-live", "polite");
    element.textContent = total.toLocaleString("en-GB");
    element.dataset.value = String(total);
  };
  if (!animate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) { finish(); return; }
  flash(element, "is-updated");
  const started = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, (now - started) / 480);
    const current = Math.round(previous + (total - previous) * (1 - (1 - progress) ** 3));
    // Announce only the final value, rather than every animation frame.
    element.setAttribute("aria-live", progress < 1 ? "off" : "polite");
    element.textContent = current.toLocaleString("en-GB");
    element.dataset.value = String(current);
    if (progress < 1) tokenFrame = requestAnimationFrame(tick);
    else finish();
  };
  tokenFrame = requestAnimationFrame(tick);
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
  if (minutes) return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
  return `${remainder}s`;
}

function runDurationSeconds(events, status) {
  const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  if (!times.length) return null;
  const start = Math.min(...times);
  const end = status === "running" ? Date.now() : Math.max(...times);
  return Math.max(0, (end - start) / 1000);
}

function statusLabel(status) {
  return ({ completed: "Completed", running: "Running", partial: "Partial", not_started: "Pending", needs_redo: "Retry", failed: "Failed", checkpointed: "Checkpoint" })[status] || status || "Unknown";
}

function phaseState(name) {
  return (dashboardData?.phases || []).find((phase) => phase.phase === name) || { phase: name, status: "not_started", present_outputs: [], missing_outputs: [] };
}

function findRollbacks(events) {
  const rollbackRows = [];
  let furthestRank = -1;
  let furthestPhase = null;
  for (const event of events) {
    const rank = phaseRank[event.phase];
    if (rank === undefined) continue;
    if (furthestRank >= 0 && rank < furthestRank) {
      rollbackRows.push({
        id: `rollback-${event.id}`,
        event: "rollback",
        timestamp: event.timestamp,
        phase: event.phase,
        from: furthestPhase,
        to: event.phase,
      });
      furthestRank = rank;
      furthestPhase = event.phase;
    } else if (rank > furthestRank) {
      furthestRank = rank;
      furthestPhase = event.phase;
    } else if (rank === furthestRank) {
      furthestPhase = event.phase;
    }
  }
  const checkpointRollbacks = (dashboardData?.phases || [])
    .filter((phase) => phase.status === "needs_redo" && !rollbackRows.some((row) => row.to === phase.phase))
    .map((phase) => ({ id: `checkpoint-${phase.phase}`, event: "rollback", phase: phase.phase, to: phase.phase, from: null, checkpoint: true }));
  return [...rollbackRows, ...checkpointRollbacks].sort((a, b) => (Number(a.id.replace(/\D/g, "")) || 0) - (Number(b.id.replace(/\D/g, "")) || 0));
}

function phaseNode(name, index, rollbacks) {
  const phase = phaseState(name);
  const status = phase.status || "not_started";
  const rollbackCount = rollbacks.filter((item) => item.to === name).length;
  const href = `/details?run=${encodeURIComponent(selectedRunId || "")}&phase=${encodeURIComponent(name)}#/state`;
  return `<a class="phase-node ${escapeHtml(status)}" href="${escapeHtml(href)}" aria-label="${escapeHtml(phaseLabels[name])}: ${escapeHtml(statusLabel(status))}${rollbackCount ? `, rollbacks: ${rollbackCount} times` : ""}, view phase details">
    <div class="phase-index">${String(index).padStart(2, "0")}</div>
    <div class="phase-name">${escapeHtml(phaseLabels[name])}</div>
    <div class="phase-state"><span class="phase-state-mark"></span>${escapeHtml(statusLabel(status))}${rollbackCount ? `<span class="rollback-count" title="Rollbacks: ${rollbackCount} times">↶ ${rollbackCount}</span>` : ""}</div>
  </a>`;
}

function pipelineConnector(kind = "straight") {
  const paths = {
    split: "M0 38 H10 V18 H24 M10 38 V58 H24 M20 15 L24 18 L20 21 M20 55 L24 58 L20 61",
    merge: "M0 18 H12 V58 H0 M12 38 H24 M20 35 L24 38 L20 41",
    straight: "M0 38 H24 M20 35 L24 38 L20 41",
  };
  return `<svg class="phase-connector" viewBox="0 0 24 76" aria-hidden="true"><path d="${paths[kind]}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function renderPipeline(rollbacks) {
  const pipeline = document.getElementById("pipeline");
  pipeline.innerHTML = [
    phaseNode("repoingest", 1, rollbacks),
    pipelineConnector("split"),
    `<div class="parallel-group" aria-label="WeightResolve and DockerSetUp parallel phases">
      <div class="parallel-caption"><span>Parallel</span></div>
      <div class="parallel-lane">${phaseNode("weightresolve", 2, rollbacks)}${phaseNode("dockersetup", 3, rollbacks)}</div>
    </div>`,
    pipelineConnector("merge"),
    phaseNode("apiadaptation", 4, rollbacks),
    pipelineConnector(),
    phaseNode("servicedelivery", 5, rollbacks),
  ].join("");

  const completed = (dashboardData?.phases || []).filter((phase) => phase.status === "completed").length;
  const active = (dashboardData?.phases || []).filter((phase) => phase.status === "running").length;
  document.getElementById("pipeline-progress").textContent = `${completed}/5 phases complete${active ? ` · ${active} running` : ""}${rollbacks.length ? ` · rollbacks: ${rollbacks.length} times` : ""}`;
}

function artifactRow(item, updated = false) {
  const id = `${item.phase || "unknown"}:${item.key}`;
  const expanded = expandedRows.artifact.has(id);
  const description = `${item.key} · ${phaseLabels[item.phase] || item.phase} · ${item.state === "present" ? "Ready" : "Pending"}`;
  return `<div class="artifact-row ${item.state}${updated ? " is-updated" : ""}${expanded ? " is-selected" : ""}" data-artifact-id="${escapeHtml(id)}" title="${escapeHtml(description)}" tabindex="0" role="button" aria-expanded="${expanded}">
    <span class="artifact-indicator" aria-hidden="true"></span><div class="artifact-copy"><span class="artifact-key">${escapeHtml(item.key)}</span><span class="artifact-status">${escapeHtml(phaseLabels[item.phase] || item.phase)} · ${item.state === "present" ? "Ready" : "Pending"}</span></div>
  </div>`;
}

function artifactRows() {
  const outputs = new Map();
  for (const phase of dashboardData?.phases || []) {
    for (const key of phase.present_outputs || []) outputs.set(`${phase.phase}:${key}`, { key, state: "present", phase: phase.phase });
    for (const key of phase.missing_outputs || []) {
      const id = `${phase.phase}:${key}`;
      if (!outputs.has(id)) outputs.set(id, { key, state: "missing", phase: phase.phase });
    }
  }
  for (const artifact of dashboardData?.artifacts || dashboardData?.variables || []) {
    if (!artifact.key) continue;
    const id = `${artifact.phase || "unknown"}:${artifact.key}`;
    if (!outputs.has(id)) outputs.set(id, { key: artifact.key, state: "present", phase: artifact.phase || "unknown" });
  }
  const phaseIndex = new Map(phaseOrder.map((phase, index) => [phase, index]));
  return [...outputs.values()].sort((a, b) => (phaseIndex.get(a.phase) ?? phaseOrder.length) - (phaseIndex.get(b.phase) ?? phaseOrder.length) || a.key.localeCompare(b.key));
}

function updateArtifactSummary(rows) {
  const presentCount = rows.filter((item) => item.state === "present").length;
  document.getElementById("artifact-count").textContent = `${presentCount}/${rows.length}`;
  document.getElementById("artifact-count").setAttribute("aria-label", `${presentCount} of ${rows.length} artifacts ready`);
  document.getElementById("artifact-summary").textContent = rows.length ? `All phases · ${presentCount} ready · ${rows.length - presentCount} pending` : "No artifact definitions available";
}

function renderArtifacts() {
  const artifactList = document.getElementById("artifact-list");
  const phases = dashboardData?.phases || [];
  if (!phases.length) {
    document.getElementById("artifact-count").textContent = "0 artifacts";
    document.getElementById("artifact-summary").textContent = "Waiting for run data";
    artifactList.innerHTML = '<div class="empty-message">No artifact records yet.</div>';
    return;
  }
  const rows = artifactRows();
  updateArtifactSummary(rows);
  artifactList.innerHTML = rows.length ? rows.map((item) => artifactRow(item)).join("") : '<div class="empty-message">No artifact snapshot yet. Outputs will appear automatically.</div>';
}

function upsertArtifact(event) {
  if (event.event !== "variable_stored" || !event.variable) return;
  const phase = event.phase || "unknown";
  const key = event.variable;
  const phaseStateRow = dashboardData.phases?.find((item) => item.phase === phase);
  if (phaseStateRow) {
    phaseStateRow.missing_outputs = (phaseStateRow.missing_outputs || []).filter((item) => item !== key);
    if (!(phaseStateRow.present_outputs || []).includes(key)) phaseStateRow.present_outputs = [...(phaseStateRow.present_outputs || []), key];
  }
  const rows = artifactRows();
  const index = rows.findIndex((item) => item.key === key && item.phase === phase);
  if (index >= 0) rows[index] = { ...rows[index], state: "present" };
  else rows.push({ key, phase, state: "present" });
  const phaseIndex = new Map(phaseOrder.map((name, order) => [name, order]));
  rows.sort((a, b) => (phaseIndex.get(a.phase) ?? phaseOrder.length) - (phaseIndex.get(b.phase) ?? phaseOrder.length) || a.key.localeCompare(b.key));

  const list = document.getElementById("artifact-list");
  list.querySelector(".empty-message")?.remove();
  const id = `${phase}:${key}`;
  const current = [...list.querySelectorAll(".artifact-row")].find((row) => row.dataset.artifactId === id);
  const rowIndex = rows.findIndex((item) => item.phase === phase && item.key === key);
  const next = list.querySelectorAll(".artifact-row")[rowIndex] || null;
  let changedRow;
  if (current) {
    current.outerHTML = artifactRow(rows[rowIndex], true);
    changedRow = [...list.querySelectorAll(".artifact-row")].find((row) => row.dataset.artifactId === id);
  }
  else {
    const template = document.createElement("template");
    template.innerHTML = artifactRow(rows[rowIndex], true);
    changedRow = template.content.firstElementChild;
    list.insertBefore(changedRow, next);
  }
  if (changedRow) {
    requestAnimationFrame(() => {
      const listRect = list.getBoundingClientRect();
      const rowRect = changedRow.getBoundingClientRect();
      let targetTop = list.scrollTop;
      if (rowRect.top < listRect.top) targetTop += rowRect.top - listRect.top;
      else if (rowRect.bottom > listRect.bottom) targetTop += rowRect.bottom - listRect.bottom;
      if (targetTop !== list.scrollTop) {
        list.scrollTo({ top: targetTop, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      }
    });
  }
  dashboardData.artifacts = rows.map((item) => ({ key: item.key, phase: item.phase, available: item.state === "present" }));
  updateArtifactSummary(rows);
}

function eventTitle(event) {
  if (event.event === "rollback") return `Phase rollback · ${phaseLabels[event.to] || event.to}`;
  if (event.event === "llm_call") return `Model call · ${phaseLabels[event.phase] || event.phase || "System"}`;
  if (event.event === "gate_stats") return `Gate statistics · ${phaseLabels[event.phase] || event.phase || "System"}`;
  if (event.event === "gate_decision") return event.intervene ? "Consistency gate · intervention" : "Consistency gate · passed";
  if (event.event === "phase_end") return `Phase complete · ${phaseLabels[event.phase] || event.phase}`;
  if (event.event === "variable_stored") return `Artifact produced · ${event.variable || "Shared state"}`;
  if (event.event === "pipeline_end") return "Pipeline complete";
  if (event.event === "step_end" && event.actor === "tool") return "Tool complete";
  if (event.event === "step_end") return `Step complete · ${event.step || event.actor || "Step"}`;
  return event.event || "Run event";
}

function eventTool(event) {
  if (event.event === "gate_decision" && event.proposed_tool) return { name: event.proposed_tool, kind: "Proposed tool" };
  if (event.producer_tool) return { name: event.producer_tool, kind: "Executed tool" };
  if (event.event === "step_end" && event.actor === "tool" && event.step) return { name: event.step, kind: "Executed tool" };
  if (event.event === "llm_call" && event.response_preview) {
    const match = String(event.response_preview).match(/"tool_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (match) {
      try { return { name: JSON.parse(`"${match[1]}"`), kind: "Model selection" }; }
      catch { return { name: match[1], kind: "Model selection" }; }
    }
  }
  return null;
}

function toolBadge(event) {
  const tool = eventTool(event);
  if (!tool) return "";
  return `<span class="trigger-tool" title="${escapeHtml(tool.kind)}" aria-label="${escapeHtml(tool.kind)}: ${escapeHtml(tool.name)}">
    <svg class="tool-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>${escapeHtml(tool.name)}</span>
  </span>`;
}

function eventMeta(event) {
  if (event.event === "rollback") return event.from ? `${phaseLabels[event.from] || event.from} rolls back to ${phaseLabels[event.to] || event.to}` : "Checkpoint marks this phase for retry";
  if (event.event === "llm_call") return `${event.backend || "Provider"}${event.model ? ` · ${event.model}` : ""} · ${event.call_type || "Call"} · ${Number(event.total_tokens || 0).toLocaleString("en-GB")} tokens · ${Number(event.duration_s || 0).toFixed(2)} s`;
  if (event.event === "gate_stats") return `Interventions ${event.interventions || 0} · Stall ${event.stall || 0} · Redundant ${event.redundant || 0} · Premature ${event.premature || 0}`;
  if (event.event === "gate_decision") return `${event.proposed_tool || "Tool"} · ${(event.fired || []).join(", ") || (event.intervene ? "Gate conditions met" : "No conditions triggered")}`;
  if (event.event === "variable_stored") return `${event.storage || "State storage"} · ${event.value_summary || "Written to shared state"}`;
  if (event.event === "phase_end") return `${Number(event.duration_s || 0).toFixed(2)} s · ${event.llm_calls || 0} LLM calls`;
  if (event.event === "step_end") return `${phaseLabels[event.phase] || event.phase} · ${Number(event.duration_s || 0).toFixed(2)} s`;
  if (event.event === "pipeline_end") return `${event.total_llm_calls || 0} LLM calls · ${Number(event.total_llm_time_s || 0).toFixed(2)} s`;
  return phaseLabels[event.phase] || event.phase || "System event";
}

function triggerItems(rollbacks) {
  const events = dashboardData?.events || [];
  const inserted = [];
  const rollbacksById = new Map(rollbacks.filter((item) => item.id.startsWith("rollback-")).map((item) => [Number(item.id.slice("rollback-".length)), item]));
  for (const event of events) {
    if (rollbacksById.has(event.id)) inserted.push(rollbacksById.get(event.id));
    if (event.event !== "rollback") inserted.push(event);
  }
  for (const checkpointRollback of rollbacks.filter((item) => item.checkpoint)) inserted.unshift(checkpointRollback);
  return inserted.reverse();
}

function triggerRow(event, isNew = false) {
  const expanded = expandedRows.trigger.has(String(event.id));
  const types = { llm_call: "LLM", step_end: "TOOL", variable_stored: "STATE", gate_decision: "GATE", gate_stats: "STAT", phase_end: "PHASE", pipeline_end: "DONE", rollback: "BACK" };
  const category = types[event.event] || "EVENT";
  const tool = eventTool(event);
  const description = `${formatTime(event.timestamp)} [${category}] ${eventTitle(event)}${tool ? ` · ${tool.kind}: ${tool.name}` : ""} · ${eventMeta(event)}`;
  return `<div class="trigger-row ${event.event === "rollback" ? "rollback" : ""}${isNew ? " is-new" : ""}${expanded ? " is-selected" : ""}" data-event-id="${escapeHtml(event.id)}" data-kind="${category.toLowerCase()}" title="${escapeHtml(description)}" tabindex="0" role="button" aria-expanded="${expanded}">
    <time class="trigger-time">${escapeHtml(formatTime(event.timestamp))}</time><span class="trigger-marker" title="${escapeHtml(event.event)}">[${category}]</span>
    <div class="trigger-copy"><div class="trigger-title-line"><div class="trigger-title">${escapeHtml(eventTitle(event))}</div>${toolBadge(event)}</div><div class="trigger-meta">${escapeHtml(eventMeta(event))}</div></div>
  </div>`;
}

function renderTriggers(rollbacks, appendOnly = false) {
  const events = triggerItems(rollbacks);
  const list = document.getElementById("trigger-events");
  document.getElementById("trigger-count").textContent = String(events.length);
  document.getElementById("trigger-count").setAttribute("aria-label", `${events.length} events`);
  if (!appendOnly) {
    list.innerHTML = events.length ? events.map((event) => triggerRow(event)).join("") : '<div class="empty-message">No events yet. Phase activity will appear here as the run progresses.</div>';
    return;
  }
  list.querySelector(".empty-message")?.remove();
  const known = new Set([...list.querySelectorAll(".trigger-row")].map((row) => row.dataset.eventId));
  const additions = events.filter((event) => !known.has(String(event.id)));
  if (!additions.length) return;
  const preserveScroll = list.scrollTop > 0;
  const oldHeight = list.scrollHeight;
  for (const event of additions.reverse()) list.insertAdjacentHTML("afterbegin", triggerRow(event, true));
  if (preserveScroll) list.scrollTop += list.scrollHeight - oldHeight;
}

function renderDashboard() {
  const run = dashboardData?.run || {};
  const service = dashboardData?.service || {};
  const events = dashboardData?.events || [];
  document.getElementById("run-title").textContent = run.id || "MADE Deployment Run";
  const runStatus = document.getElementById("run-status");
  runStatus.className = `status-pill ${run.status || "neutral"}`;
  runStatus.textContent = statusLabel(run.status);
  const duration = runDurationSeconds(events, run.status);
  setDuration(duration, false);
  const totalTokens = dashboardData?.totals?.total_tokens ?? events
    .filter((event) => event.event === "llm_call")
    .reduce((sum, event) => sum + Number(event.total_tokens || 0), 0);
  setTokenCount(totalTokens, false);
  document.querySelectorAll(".live-metric").forEach((metric) => metric.classList.toggle("is-live", run.status === "running"));
  document.getElementById("provider-badge").textContent = `${run.provider || "Provider unavailable"}${run.model ? ` · ${run.model}` : ""}`;
  for (const id of ["run-title", "provider-badge", "container-status"]) {
    const element = document.getElementById(id);
    element.title = element.textContent;
  }
  document.getElementById("container-status").textContent = service.container_status || "Not started";
  document.getElementById("container-status").title = document.getElementById("container-status").textContent;
  document.getElementById("last-updated").textContent = run.updated_at ? formatTime(run.updated_at) : "—";
  const rollbacks = findRollbacks(events);
  renderPipeline(rollbacks);
  renderArtifacts();
  renderTriggers(rollbacks);
  syncExpansionControls();
}

function updateRunMetrics() {
  if (!dashboardData) return;
  const duration = runDurationSeconds(dashboardData.events || [], dashboardData.run?.status);
  setDuration(duration);
}

function applyLiveEvent(event) {
  if (!dashboardData || (dashboardData.events || []).some((item) => Number(item.id) === Number(event.id))) return;
  dashboardData.events = [...(dashboardData.events || []), event].slice(-1000);
  dashboardData.totals = dashboardData.totals || {};
  if (dashboardData.run.status !== "completed") dashboardData.run.status = "running";
  if (event.event === "llm_call") {
    dashboardData.totals.llm_calls = Number(dashboardData.totals.llm_calls || 0) + 1;
    dashboardData.totals.total_tokens = Number(dashboardData.totals.total_tokens || 0) + Number(event.total_tokens || 0);
    if (event.backend) dashboardData.run.provider = event.backend;
    if (event.model) dashboardData.run.model = event.model;
  }
  if (event.event === "phase_end") {
    dashboardData.phases = (dashboardData.phases || []).map((phase) => phase.phase === event.phase ? { ...phase, status: "completed" } : phase);
  } else if (event.phase && dashboardData.run.status !== "completed") {
    dashboardData.phases = (dashboardData.phases || []).map((phase) => phase.phase === event.phase && phase.status !== "completed" ? { ...phase, status: "running" } : phase);
  }
  if (event.event === "pipeline_end") {
    dashboardData.run.status = "completed";
    dashboardData.totals.llm_calls = Number(event.total_llm_calls || dashboardData.totals.llm_calls || 0);
    dashboardData.totals.total_tokens = Number(event.total_tokens || dashboardData.totals.total_tokens || 0);
  }
  if (event.timestamp) dashboardData.run.updated_at = event.timestamp;
  if (event.phase) dashboardData.run.latest_phase = event.phase;

  const duration = runDurationSeconds(dashboardData.events, dashboardData.run.status);
  setDuration(duration);
  setTokenCount(dashboardData.totals.total_tokens || 0);
  document.querySelectorAll(".live-metric").forEach((metric) => metric.classList.toggle("is-live", dashboardData.run.status === "running"));
  document.getElementById("run-status").className = `status-pill ${dashboardData.run.status || "neutral"}`;
  document.getElementById("run-status").textContent = statusLabel(dashboardData.run.status);
  document.getElementById("provider-badge").textContent = `${dashboardData.run.provider || "Provider unavailable"}${dashboardData.run.model ? ` · ${dashboardData.run.model}` : ""}`;
  document.getElementById("provider-badge").title = document.getElementById("provider-badge").textContent;
  document.getElementById("last-updated").textContent = formatTime(event.timestamp);

  const rollbacks = findRollbacks(dashboardData.events);
  renderPipeline(rollbacks);
  upsertArtifact(event);
  renderTriggers(rollbacks, true);
  syncExpansionControls();
  if (event.event === "pipeline_end") {
    liveEvents?.close();
    liveEvents = null;
  }
}

function connectLiveEvents() {
  liveEvents?.close();
  liveEvents = null;
  if (!selectedRunId || dashboardData?.run?.status === "completed" || !("EventSource" in window)) return;
  const lastId = Math.max(0, ...(dashboardData?.events || []).map((event) => Number(event.id) || 0));
  liveEvents = new EventSource(`/api/runs/${encodeURIComponent(selectedRunId)}/events?after_id=${lastId}`);
  liveEvents.addEventListener("update", (message) => {
    try { applyLiveEvent(JSON.parse(message.data)); }
    catch (error) { console.error("Unable to process live run event", error); }
  });
  liveEvents.onerror = () => {
    if (dashboardData?.run?.status === "completed") {
      liveEvents?.close();
      liveEvents = null;
    }
  };
}

async function loadRuns() {
  const response = await fetch("/api/runs", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load runs");
  const runs = await response.json();
  runs.sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0));
  if (!runs.some((run) => run.id === selectedRunId)) selectedRunId = runs[0]?.id || null;
  const select = document.getElementById("run-select");
  select.innerHTML = runs.length ? runs.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id)} · ${escapeHtml(phaseLabels[run.latest_phase] || run.latest_phase || statusLabel(run.status))}</option>`).join("") : '<option value="">No runs available</option>';
  select.value = selectedRunId || "";
  return runs.length > 0;
}

async function loadSelectedRun() {
  if (!selectedRunId) {
    dashboardData = null;
    renderDashboard();
    return;
  }
  const requestedRunId = selectedRunId;
  const response = await fetch(`/api/runs/${encodeURIComponent(requestedRunId)}?event_limit=1000`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load run details");
  const payload = await response.json();
  if (requestedRunId !== selectedRunId) return;
  if (loadedRunId !== requestedRunId) {
    expandedRows.trigger.clear();
    expandedRows.artifact.clear();
    loadedRunId = requestedRunId;
  }
  dashboardData = payload;
  const url = new URL(window.location.href);
  url.searchParams.set("run", requestedRunId);
  window.history.replaceState(null, "", url);
  renderDashboard();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const found = await loadRuns();
    await loadSelectedRun();
    connectLiveEvents();
    document.getElementById("last-updated").dataset.synced = new Date().toISOString();
    if (!found) document.getElementById("run-title").textContent = "No runs available";
  } catch (error) {
    document.getElementById("run-title").textContent = error.message;
  } finally {
    refreshing = false;
  }
}

const monitor = document.querySelector(".monitor-layout");
function rowKind(row) { return row.classList.contains("artifact-row") ? "artifact" : "trigger"; }
function setRowExpanded(row, expanded) {
  const kind = rowKind(row);
  const id = kind === "artifact" ? row.dataset.artifactId : row.dataset.eventId;
  if (expanded) expandedRows[kind].add(id);
  else expandedRows[kind].delete(id);
  row.classList.toggle("is-selected", expanded);
  row.setAttribute("aria-expanded", String(expanded));
}
function syncExpansionControls() {
  for (const kind of ["trigger", "artifact"]) {
    const rows = [...monitor.querySelectorAll(`.${kind}-row`)];
    const allExpanded = rows.length > 0 && rows.every((row) => row.getAttribute("aria-expanded") === "true");
    const button = document.getElementById(`expand-${kind}`);
    button.disabled = !rows.length;
    button.textContent = allExpanded ? "Collapse all" : "Expand all";
    button.setAttribute("aria-expanded", String(allExpanded));
    button.setAttribute("aria-label", `${allExpanded ? "Collapse" : "Expand"} all ${kind === "trigger" ? "events" : "artifacts"}`);
  }
}
function selectRow(row) {
  setRowExpanded(row, row.getAttribute("aria-expanded") !== "true");
  syncExpansionControls();
  flash(row);
}
for (const kind of ["trigger", "artifact"]) {
  document.getElementById(`expand-${kind}`).addEventListener("click", (event) => {
    const expanded = event.currentTarget.getAttribute("aria-expanded") !== "true";
    monitor.querySelectorAll(`.${kind}-row`).forEach((row) => setRowExpanded(row, expanded));
    syncExpansionControls();
  });
}
monitor.addEventListener("click", (event) => {
  const row = event.target.closest(".trigger-row, .artifact-row");
  if (row) selectRow(row);
  else flash(event.target.closest(".context-metric, .phase-node, button, select"));
});
monitor.addEventListener("keydown", (event) => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".trigger-row, .artifact-row")) {
    event.preventDefault(); selectRow(event.target);
  }
});
monitor.addEventListener("animationend", (event) => {
  if (event.animationName === "monitor-feedback" || event.animationName === "terminal-feedback") event.target.classList.remove("is-feedback");
  if (event.animationName === "monitor-metric") event.target.classList.remove("is-updated");
});

document.getElementById("refresh-button").addEventListener("click", refresh);
document.getElementById("run-select").addEventListener("change", (event) => {
  selectedRunId = event.target.value || null;
  flash(event.target);
  liveEvents?.close();
  loadSelectedRun().then(connectLiveEvents).catch((error) => { document.getElementById("run-title").textContent = error.message; });
});
document.getElementById("back-button").addEventListener("click", () => {
  const runQuery = selectedRunId ? `?run=${encodeURIComponent(selectedRunId)}` : "";
  window.location.assign(`/details${runQuery}#/overview`);
});

refresh();
window.setInterval(updateRunMetrics, 1000);
