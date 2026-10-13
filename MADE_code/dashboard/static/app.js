const phaseLabels = {
  repoingest: "RepoIngest",
  weightresolve: "WeightResolve",
  dockersetup: "DockerSetUp",
  apiadaptation: "APIAdaptation",
  servicedelivery: "ServiceDelivery",
};

const phaseDescriptions = {
  repoingest: "读取论文或 GitHub 输入，克隆仓库并确定部署任务。",
  weightresolve: "解析并准备模型权重和辅助文件。",
  dockersetup: "生成 Docker 配置、构建镜像并启动运行容器。",
  apiadaptation: "将原始推理入口适配为可调用的模型服务。",
  servicedelivery: "启动 API、执行测试并整理交付文档。",
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

  const banner = document.getElementById("rollback-banner");
  const latest = rollbacks[rollbacks.length - 1];
  if (!latest) {
    banner.hidden = true;
    banner.innerHTML = "";
  } else {
    const from = latest.from ? phaseLabels[latest.from] : "检查点";
    banner.innerHTML = `<strong>检测到回退</strong><span>${escapeHtml(from)} → ${escapeHtml(phaseLabels[latest.to] || latest.to)} · 共 ${rollbacks.length} 次回退记录</span>`;
    banner.hidden = false;
  }

  const completed = (dashboardData?.phases || []).filter((phase) => phase.status === "completed").length;
  const active = (dashboardData?.phases || []).filter((phase) => phase.status === "running").length;
  document.getElementById("pipeline-progress").textContent = `${completed}/5 阶段成功${active ? ` · ${active} 个进行中` : ""}${rollbacks.length ? ` · 回退 ${rollbacks.length} 次` : ""}`;
}

function currentPhases() {
  const phases = dashboardData?.phases || [];
  const running = phases.filter((phase) => phase.status === "running");
  if (running.length) return running;
  const events = dashboardData?.events || [];
  const latestPhase = [...events].reverse().find((event) => phaseRank[event.phase] !== undefined)?.phase || dashboardData?.run?.latest_phase;
  if (latestPhase) return [phaseState(latestPhase)];
  const redo = phases.filter((phase) => phase.status === "needs_redo");
  return redo.slice(0, 1);
}

function renderCurrentAndArtifacts() {
  const phases = currentPhases();
  const currentStatus = document.getElementById("current-stage-status");
  const currentName = document.getElementById("current-stage-name");
  const currentIndex = document.getElementById("current-stage-index");
  const currentDescription = document.getElementById("current-stage-description");
  const currentNote = document.getElementById("current-stage-note");
  const artifactStage = document.getElementById("artifact-stage");
  const artifactCount = document.getElementById("artifact-count");
  const artifactSummary = document.getElementById("artifact-summary");
  const artifactList = document.getElementById("artifact-list");

  if (!phases.length) {
    currentStatus.className = "status-pill neutral";
    currentStatus.textContent = "等待运行";
    currentIndex.textContent = "—";
    currentName.textContent = "尚未开始";
    currentDescription.textContent = "选择一条运行记录后，这里会显示当前阶段。";
    currentNote.textContent = "尚无阶段事件";
    artifactStage.textContent = "尚无当前阶段";
    artifactCount.textContent = "0 项";
    artifactSummary.textContent = "等待运行数据";
    artifactList.innerHTML = '<div class="empty-message">暂无阶段产物记录。</div>';
    return;
  }

  const labels = phases.map((phase) => phaseLabels[phase.phase] || phase.phase);
  const isParallel = phases.length > 1;
  const status = phases.some((phase) => phase.status === "running") ? "running" : (phases[0].status || "not_started");
  currentStatus.className = `status-pill ${status}`;
  currentStatus.textContent = isParallel ? "并行进行中" : statusLabel(status);
  currentIndex.textContent = isParallel ? "并行" : `阶段 ${String(phaseOrder.indexOf(phases[0].phase) + 1).padStart(2, "0")}`;
  currentName.textContent = labels.join(" / ");
  currentDescription.textContent = isParallel ? "两个并行分支分别推进，任一分支触发回退时会在流程图和事件列表中同步标记。" : (phaseDescriptions[phases[0].phase] || "阶段详情");

  const latestEvent = [...(dashboardData?.events || [])].reverse().find((event) => phases.some((phase) => phase.phase === event.phase));
  currentNote.textContent = latestEvent ? `最近阶段事件：${formatTime(latestEvent.timestamp)} · ${latestEvent.event}` : "阶段产物状态来自共享状态与阶段检查点";
  artifactStage.textContent = labels.join(" / ");

  const outputs = phases.flatMap((phase) => [
    ...(phase.present_outputs || []).map((key) => ({ key, state: "present", phase: phase.phase })),
    ...(phase.missing_outputs || []).map((key) => ({ key, state: "missing", phase: phase.phase })),
  ]);
  const uniqueOutputs = [...new Map(outputs.map((item) => [`${item.phase}:${item.key}`, item])).values()];
  const presentCount = uniqueOutputs.filter((item) => item.state === "present").length;
  artifactCount.textContent = `${presentCount}/${uniqueOutputs.length} 项`;
  artifactSummary.textContent = uniqueOutputs.length ? `${presentCount} 项已生成 · ${uniqueOutputs.length - presentCount} 项待生成` : "此阶段暂无定义的产物清单";
  artifactList.innerHTML = uniqueOutputs.length ? uniqueOutputs.map((item) => `<div class="artifact-row ${item.state}">
    <span class="artifact-indicator" aria-hidden="true"></span><div><div class="artifact-key">${escapeHtml(item.key)}</div><div class="artifact-status">${escapeHtml(phaseLabels[item.phase] || item.phase)} · ${item.state === "present" ? "已生成" : "待生成"}</div></div>
  </div>`).join("") : '<div class="empty-message">当前阶段尚无产物快照；运行产生后将自动显示。</div>';
}

function eventTitle(event) {
  if (event.event === "rollback") return `阶段回退 · ${phaseLabels[event.to] || event.to}`;
  if (event.event === "gate_decision") return event.intervene ? "一致性门控 · 触发干预" : "一致性门控 · 放行";
  if (event.event === "phase_end") return `阶段完成 · ${phaseLabels[event.phase] || event.phase}`;
  if (event.event === "variable_stored") return `产物生成 · ${event.variable || "共享状态"}`;
  if (event.event === "pipeline_end") return "总体流程完成";
  if (event.event === "step_end") return `执行步骤完成 · ${event.step || event.actor || "步骤"}`;
  return event.event || "运行事件";
}

function eventMeta(event) {
  if (event.event === "rollback") return event.from ? `${phaseLabels[event.from] || event.from} 回退至 ${phaseLabels[event.to] || event.to}` : "检查点标记此阶段需要重跑";
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
    if (["gate_decision", "phase_end", "variable_stored", "pipeline_end", "step_end"].includes(event.event)) inserted.push(event);
  }
  for (const checkpointRollback of rollbacks.filter((item) => item.checkpoint)) inserted.unshift(checkpointRollback);
  const recent = inserted.slice(-14).reverse();
  document.getElementById("trigger-count").textContent = `${recent.length} 条`;
  document.getElementById("trigger-events").innerHTML = recent.length ? recent.map((event) => `<div class="trigger-row ${event.event === "rollback" ? "rollback" : ""}">
    <time class="trigger-time">${escapeHtml(formatTime(event.timestamp))}</time><span class="trigger-marker" aria-hidden="true"></span>
    <div class="trigger-copy"><div class="trigger-title">${escapeHtml(eventTitle(event))}</div><div class="trigger-meta">${escapeHtml(eventMeta(event))}</div></div>
  </div>`).join("") : '<div class="empty-message">暂无触发事件。运行推进后，阶段完成、产物写入和门控决策会实时显示在这里。</div>';
}

function renderDashboard() {
  const run = dashboardData?.run || {};
  const service = dashboardData?.service || {};
  document.getElementById("run-title").textContent = run.id || "MADE Deployment Run";
  const runStatus = document.getElementById("run-status");
  runStatus.className = `status-pill ${run.status || "neutral"}`;
  runStatus.textContent = statusLabel(run.status);
  document.getElementById("provider-badge").textContent = `${run.provider || "模型服务未记录"}${run.model ? ` · ${run.model}` : ""}`;
  document.getElementById("container-status").textContent = service.container_status || "未启动";
  document.getElementById("last-updated").textContent = run.updated_at ? formatTime(run.updated_at) : "—";
  const events = dashboardData?.events || [];
  const rollbacks = findRollbacks(events);
  renderPipeline(rollbacks);
  renderCurrentAndArtifacts();
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
