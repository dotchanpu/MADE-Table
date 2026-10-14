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

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  if (hours) return `${hours}小时${String(minutes).padStart(2, "0")}分`;
  if (minutes) return `${minutes}分${String(remainder).padStart(2, "0")}秒`;
  return `${remainder}秒`;
}

function runDurationSeconds(events, status) {
  const times = events.map((event) => Date.parse(event.timestamp)).filter(Number.isFinite);
  if (!times.length) return null;
  const start = Math.min(...times);
  const end = status === "running" ? Date.now() : Math.max(...times);
  return Math.max(0, (end - start) / 1000);
}

function statusLabel(status) {
  return ({ completed: "成功", running: "进行中", partial: "部分完成", not_started: "未开始", needs_redo: "回退重跑", failed: "失败", checkpointed: "检查点" })[status] || status || "未知";
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
  return `<div class="phase-node ${escapeHtml(status)}" aria-label="${escapeHtml(phaseLabels[name])}：${escapeHtml(statusLabel(status))}${rollbackCount ? `，曾回退 ${rollbackCount} 次` : ""}">
    <div class="phase-index">${String(index).padStart(2, "0")}</div>
    <div class="phase-name">${escapeHtml(phaseLabels[name])}</div>
    <div class="phase-state"><span class="phase-state-mark"></span>${escapeHtml(statusLabel(status))}${rollbackCount ? `<span class="rollback-count">曾回退 ${rollbackCount} 次</span>` : ""}</div>
  </div>`;
}

function renderPipeline(rollbacks) {
  const pipeline = document.getElementById("pipeline");
  pipeline.innerHTML = [
    phaseNode("repoingest", 1, rollbacks),
    '<div class="phase-connector" aria-hidden="true"></div>',
    `<div class="parallel-group" aria-label="WeightResolve 与 DockerSetUp 并行阶段">
      <div class="parallel-caption"><span>并行执行</span></div>
      <div class="parallel-lane">${phaseNode("weightresolve", 2, rollbacks)}${phaseNode("dockersetup", 3, rollbacks)}</div>
    </div>`,
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("apiadaptation", 4, rollbacks),
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("servicedelivery", 5, rollbacks),
  ].join("");

  const completed = (dashboardData?.phases || []).filter((phase) => phase.status === "completed").length;
  const active = (dashboardData?.phases || []).filter((phase) => phase.status === "running").length;
  document.getElementById("pipeline-progress").textContent = `${completed}/5 阶段成功${active ? ` · ${active} 个进行中` : ""}${rollbacks.length ? ` · 回退 ${rollbacks.length} 次` : ""}`;
}

function renderArtifacts() {
  const artifactCount = document.getElementById("artifact-count");
  const artifactSummary = document.getElementById("artifact-summary");
  const artifactList = document.getElementById("artifact-list");
  const phases = dashboardData?.phases || [];
  if (!phases.length) {
    artifactCount.textContent = "0 项";
    artifactSummary.textContent = "等待运行数据";
    artifactList.innerHTML = '<div class="empty-message">暂无全阶段产物记录。</div>';
    return;
  }

  const outputs = new Map();
  for (const phase of phases) {
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
  const uniqueOutputs = [...outputs.values()].sort((a, b) => (phaseIndex.get(a.phase) ?? phaseOrder.length) - (phaseIndex.get(b.phase) ?? phaseOrder.length) || a.key.localeCompare(b.key));
  const presentCount = uniqueOutputs.filter((item) => item.state === "present").length;
  artifactCount.textContent = `${presentCount}/${uniqueOutputs.length} 项`;
  artifactSummary.textContent = uniqueOutputs.length ? `全阶段 · ${presentCount} 项已生成 · ${uniqueOutputs.length - presentCount} 项待生成` : "全阶段暂无定义的产物清单";
  artifactList.innerHTML = uniqueOutputs.length ? uniqueOutputs.map((item) => `<div class="artifact-row ${item.state}">
    <span class="artifact-indicator" aria-hidden="true"></span><div><div class="artifact-key">${escapeHtml(item.key)}</div><div class="artifact-status">${escapeHtml(phaseLabels[item.phase] || item.phase)} · ${item.state === "present" ? "已生成" : "待生成"}</div></div>
  </div>`).join("") : '<div class="empty-message">全阶段尚无产物快照；运行产生后将自动显示。</div>';
}

function eventTitle(event) {
  if (event.event === "rollback") return `阶段回退 · ${phaseLabels[event.to] || event.to}`;
  if (event.event === "llm_call") return `模型调用 · ${phaseLabels[event.phase] || event.phase || "系统"}`;
  if (event.event === "gate_stats") return `一致性门控统计 · ${phaseLabels[event.phase] || event.phase || "系统"}`;
  if (event.event === "gate_decision") return event.intervene ? "一致性门控 · 触发干预" : "一致性门控 · 放行";
  if (event.event === "phase_end") return `阶段完成 · ${phaseLabels[event.phase] || event.phase}`;
  if (event.event === "variable_stored") return `产物生成 · ${event.variable || "共享状态"}`;
  if (event.event === "pipeline_end") return "总体流程完成";
  if (event.event === "step_end" && event.actor === "tool") return "工具执行完成";
  if (event.event === "step_end") return `执行步骤完成 · ${event.step || event.actor || "步骤"}`;
  return event.event || "运行事件";
}

function eventTool(event) {
  if (event.event === "gate_decision" && event.proposed_tool) return { name: event.proposed_tool, kind: "候选工具" };
  if (event.producer_tool) return { name: event.producer_tool, kind: "执行工具" };
  if (event.event === "step_end" && event.actor === "tool" && event.step) return { name: event.step, kind: "执行工具" };
  if (event.event === "llm_call" && event.response_preview) {
    const match = String(event.response_preview).match(/"tool_name"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/);
    if (match) {
      try { return { name: JSON.parse(`"${match[1]}"`), kind: "模型选择" }; }
      catch { return { name: match[1], kind: "模型选择" }; }
    }
  }
  return null;
}

function toolBadge(event) {
  const tool = eventTool(event);
  if (!tool) return "";
  return `<span class="trigger-tool" title="${escapeHtml(tool.kind)}" aria-label="${escapeHtml(tool.kind)}：${escapeHtml(tool.name)}">
    <svg class="tool-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <span>${escapeHtml(tool.name)}</span>
  </span>`;
}

function eventMeta(event) {
  if (event.event === "rollback") return event.from ? `${phaseLabels[event.from] || event.from} 回退至 ${phaseLabels[event.to] || event.to}` : "检查点标记此阶段需要重跑";
  if (event.event === "llm_call") return `${event.backend || "模型服务"}${event.model ? ` · ${event.model}` : ""} · ${event.call_type || "调用"} · ${Number(event.total_tokens || 0).toLocaleString("zh-CN")} tokens · ${Number(event.duration_s || 0).toFixed(2)} 秒`;
  if (event.event === "gate_stats") return `干预 ${event.interventions || 0} · 停滞 ${event.stall || 0} · 冗余 ${event.redundant || 0} · 过早 ${event.premature || 0}`;
  if (event.event === "gate_decision") return `${event.proposed_tool || "工具"} · ${(event.fired || []).join("、") || (event.intervene ? "门控条件满足" : "无触发条件")}`;
  if (event.event === "variable_stored") return `${event.storage || "状态存储"} · ${event.value_summary || "已写入共享状态"}`;
  if (event.event === "phase_end") return `${Number(event.duration_s || 0).toFixed(2)} 秒 · ${event.llm_calls || 0} 次模型调用`;
  if (event.event === "step_end") return `${phaseLabels[event.phase] || event.phase} · ${Number(event.duration_s || 0).toFixed(2)} 秒`;
  if (event.event === "pipeline_end") return `${event.total_llm_calls || 0} 次模型调用 · ${Number(event.total_llm_time_s || 0).toFixed(2)} 秒`;
  return phaseLabels[event.phase] || event.phase || "系统事件";
}

function renderTriggers(rollbacks) {
  const events = dashboardData?.events || [];
  const inserted = [];
  const rollbacksById = new Map(rollbacks.filter((item) => item.id.startsWith("rollback-")).map((item) => [Number(item.id.slice("rollback-".length)), item]));
  for (const event of events) {
    if (rollbacksById.has(event.id)) inserted.push(rollbacksById.get(event.id));
    if (event.event !== "rollback") inserted.push(event);
  }
  for (const checkpointRollback of rollbacks.filter((item) => item.checkpoint)) inserted.unshift(checkpointRollback);
  const allEvents = inserted.reverse();
  document.getElementById("trigger-count").textContent = `${allEvents.length} 条`;
  document.getElementById("trigger-events").innerHTML = allEvents.length ? allEvents.map((event) => `<div class="trigger-row ${event.event === "rollback" ? "rollback" : ""}">
    <time class="trigger-time">${escapeHtml(formatTime(event.timestamp))}</time><span class="trigger-marker" aria-hidden="true"></span>
    <div class="trigger-copy"><div class="trigger-title-line"><div class="trigger-title">${escapeHtml(eventTitle(event))}</div>${toolBadge(event)}</div><div class="trigger-meta">${escapeHtml(eventMeta(event))}</div></div>
  </div>`).join("") : '<div class="empty-message">暂无全流程事件。运行推进后，各阶段活动会实时显示在这里。</div>';
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
  document.getElementById("run-duration").textContent = duration === null ? "—" : formatDuration(duration);
  const totalTokens = dashboardData?.totals?.total_tokens ?? events
    .filter((event) => event.event === "llm_call")
    .reduce((sum, event) => sum + Number(event.total_tokens || 0), 0);
  document.getElementById("run-tokens").textContent = Number(totalTokens).toLocaleString("zh-CN");
  document.getElementById("provider-badge").textContent = `${run.provider || "模型服务未记录"}${run.model ? ` · ${run.model}` : ""}`;
  document.getElementById("container-status").textContent = service.container_status || "未启动";
  document.getElementById("last-updated").textContent = run.updated_at ? formatTime(run.updated_at) : "—";
  const rollbacks = findRollbacks(events);
  renderPipeline(rollbacks);
  renderArtifacts();
  renderTriggers(rollbacks);
}

async function loadRuns() {
  const response = await fetch("/api/runs", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取运行记录");
  const runs = await response.json();
  runs.sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0));
  if (!runs.some((run) => run.id === selectedRunId)) selectedRunId = runs[0]?.id || null;
  const select = document.getElementById("run-select");
  select.innerHTML = runs.length ? runs.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id)} · ${escapeHtml(phaseLabels[run.latest_phase] || run.latest_phase || statusLabel(run.status))}</option>`).join("") : '<option value="">暂无运行记录</option>';
  select.value = selectedRunId || "";
  return runs.length > 0;
}

async function loadSelectedRun() {
  if (!selectedRunId) {
    dashboardData = null;
    renderDashboard();
    return;
  }
  const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}?event_limit=1000`, { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取运行详情");
  dashboardData = await response.json();
  renderDashboard();
}

let refreshing = false;
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const found = await loadRuns();
    await loadSelectedRun();
    document.getElementById("last-updated").dataset.synced = new Date().toISOString();
    if (!found) document.getElementById("run-title").textContent = "暂无运行记录";
  } catch (error) {
    document.getElementById("run-title").textContent = error.message;
  } finally {
    refreshing = false;
  }
}

document.getElementById("refresh-button").addEventListener("click", refresh);
document.getElementById("run-select").addEventListener("change", (event) => {
  selectedRunId = event.target.value || null;
  loadSelectedRun().catch((error) => { document.getElementById("run-title").textContent = error.message; });
});
document.getElementById("back-button").addEventListener("click", () => {
  const runQuery = selectedRunId ? `?run=${encodeURIComponent(selectedRunId)}` : "";
  window.location.assign(`/details${runQuery}#/overview`);
});

refresh();
window.setInterval(refresh, 3000);
