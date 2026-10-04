const phaseLabels = {
  repoingest: "RepoIngest",
  weightresolve: "WeightResolve",
  dockersetup: "DockerSetUp",
  apiadaptation: "APIAdaptation",
  servicedelivery: "ServiceDelivery",
};

const phaseDescriptions = {
  repoingest: "读取论文或 GitHub 输入，克隆仓库并确定部署任务。",
  weightresolve: "解析、下载并验证模型权重和辅助文件。",
  dockersetup: "生成 Dockerfile，构建镜像并启动运行容器。",
  apiadaptation: "把原始推理入口适配成 load / preprocess / inference / postprocess 服务。",
  servicedelivery: "启动 API，执行测试，修复运行问题并生成 API 文档。",
};

let selectedRunId = null;
let dashboardData = null;
let selectedPhase = "repoingest";
let currentPage = "overview";

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatStatus(status) {
  return {
    completed: "已完成",
    running: "运行中",
    partial: "部分完成",
    not_started: "未开始",
    needs_redo: "需要重做",
    checkpointed: "已保存检查点",
    failed: "失败",
    completed: "已完成",
  }[status] || status || "未知";
}

function statusClass(status) {
  return status || "neutral";
}

function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function compactNumber(value) {
  return Number(value || 0).toLocaleString("zh-CN");
}

function phaseByName(name) {
  return (dashboardData?.phases || []).find((phase) => phase.phase === name) || {
    phase: name,
    status: "not_started",
    present_outputs: [],
    missing_outputs: [],
  };
}

function phaseNode(name, index) {
  const phase = phaseByName(name);
  const selected = selectedPhase === name ? " selected" : "";
  const status = phase.status || "not_started";
  return `<button class="phase-node ${escapeHtml(status)}${selected}" data-phase="${escapeHtml(name)}" type="button">
    <div class="phase-index">0${index}</div>
    <div class="phase-name">${escapeHtml(phaseLabels[name] || name)}</div>
    <div class="phase-status"><span class="status-dot"></span>${escapeHtml(formatStatus(status))}</div>
  </button>`;
}

function renderPipeline() {
  const pipeline = document.getElementById("pipeline");
  pipeline.innerHTML = [
    phaseNode("repoingest", 1),
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("weightresolve", 2),
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("dockersetup", 3),
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("apiadaptation", 4),
    '<div class="phase-connector" aria-hidden="true"></div>',
    phaseNode("servicedelivery", 5),
  ].join("");
  pipeline.querySelectorAll("[data-phase]").forEach((node) => {
    node.addEventListener("click", () => {
      selectedPhase = node.dataset.phase;
      renderPipeline();
      renderPhaseDetail();
    });
  });
}

function phaseDetailMarkup(phase) {
  const present = phase.present_outputs || [];
  const missing = phase.missing_outputs || [];
  const outputRows = [
    ...present.map((key) => `<div class="output-row present"><span class="output-check">✓</span><code>${escapeHtml(key)}</code></div>`),
    ...missing.map((key) => `<div class="output-row missing"><span class="output-check">·</span><code>${escapeHtml(key)}</code></div>`),
  ].join("");
  return `
    <div class="detail-list">
      <div class="detail-row"><span class="detail-key">阶段目标</span><span class="detail-value">${escapeHtml(phaseDescriptions[phase.phase] || "—")}</span></div>
      <div class="detail-row"><span class="detail-key">已产出</span><span class="detail-value">${present.length} 项</span></div>
      <div class="detail-row"><span class="detail-key">缺失产物</span><span class="detail-value">${missing.length} 项</span></div>
    </div>
    <div class="eyebrow" style="margin-top:18px">REQUIRED OUTPUTS</div>
    <div class="output-list">${outputRows || '<div class="muted small">暂无 required outputs 记录</div>'}</div>
  `;
}

function renderPhaseDetail() {
  const phase = phaseByName(selectedPhase);
  const statePhaseSelect = document.getElementById("state-phase-select");
  if (statePhaseSelect) statePhaseSelect.value = selectedPhase;
  document.getElementById("phase-detail-title").textContent = phaseLabels[selectedPhase] || selectedPhase;
  const status = document.getElementById("phase-detail-status");
  status.className = `status-pill ${statusClass(phase.status)}`;
  status.textContent = formatStatus(phase.status);
  document.getElementById("phase-detail").className = "phase-detail";
  document.getElementById("phase-detail").innerHTML = phaseDetailMarkup(phase);
  document.getElementById("overview-phase-title").textContent = phaseLabels[selectedPhase] || selectedPhase;
  const overviewStatus = document.getElementById("overview-phase-status");
  overviewStatus.className = `status-pill ${statusClass(phase.status)}`;
  overviewStatus.textContent = formatStatus(phase.status);
  document.getElementById("overview-phase-detail").innerHTML = phaseDetailMarkup(phase);
}

function renderState() {
  const rows = dashboardData?.variables || [];
  document.getElementById("state-count").textContent = `${rows.length} variables`;
  const body = document.getElementById("state-table");
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="4" class="muted">当前运行还没有共享状态快照。</td></tr>';
    return;
  }
  body.innerHTML = rows.map((row) => `<tr>
    <td>${escapeHtml(row.key)}</td>
    <td>${escapeHtml(phaseLabels[row.phase] || row.phase || "—")}</td>
    <td>${escapeHtml(row.value || "—")}</td>
    <td>${escapeHtml(row.producer_tool || row.storage || "checkpoint")}</td>
  </tr>`).join("");
}

function renderPhaseLedger() {
  const body = document.getElementById("phase-ledger");
  body.innerHTML = (dashboardData?.phases || []).map((phase) => `<tr>
    <td>${escapeHtml(phaseLabels[phase.phase] || phase.phase)}</td>
    <td><span class="status-pill ${statusClass(phase.status)}">${escapeHtml(formatStatus(phase.status))}</span></td>
    <td>${escapeHtml((phase.present_outputs || []).join(", ") || "—")}</td>
    <td>${escapeHtml((phase.missing_outputs || []).join(", ") || "—")}</td>
  </tr>`).join("") || '<tr><td colspan="4" class="muted">暂无阶段账本。</td></tr>';
}

function eventTitle(event) {
  if (event.event === "llm_call") return `${event.actor || "LLM"} · ${event.call_type || "query"}`;
  if (event.event === "step_end") return `${event.actor || "tool"} · ${event.step || "step"}`;
  if (event.event === "gate_decision") return event.intervene ? "一致性门控 · 触发干预" : "一致性门控 · 放行";
  if (event.event === "variable_stored") return `共享状态 · ${event.variable || "variable"}`;
  if (event.event === "phase_end") return `阶段完成 · ${phaseLabels[event.phase] || event.phase}`;
  if (event.event === "gate_stats") return "一致性门控 · 统计";
  if (event.event === "pipeline_end") return "流水线 · 完成";
  return event.event || "system";
}

function eventMeta(event) {
  if (event.event === "llm_call") {
    return `${event.model || event.backend || "model"} · ${compactNumber(event.total_tokens)} tokens · ${Number(event.duration_s || 0).toFixed(2)}s`;
  }
  if (event.event === "step_end") return `${event.phase || "unknown"} · ${Number(event.duration_s || 0).toFixed(2)}s`;
  if (event.event === "gate_decision") {
    const fired = event.fired?.length ? `触发：${event.fired.join(", ")}` : "无触发条件";
    return `${event.proposed_tool || "tool"} · ${fired}`;
  }
  if (event.event === "variable_stored") return `${event.storage || "state"} · ${event.value_summary || "已写入"}`;
  if (event.event === "phase_end") return `${Number(event.duration_s || 0).toFixed(2)}s · ${event.llm_calls || 0} LLM calls`;
  if (event.event === "gate_stats") return `interventions: ${event.interventions || 0} · stall: ${event.stall || 0}`;
  return event.phase || "system";
}

function renderTimeline() {
  const filter = document.getElementById("event-filter").value;
  const events = (dashboardData?.events || []).filter((event) => filter === "all" || event.event === filter).slice().reverse();
  const timeline = document.getElementById("timeline");
  if (!events.length) {
    timeline.innerHTML = '<div class="empty-state">暂无匹配事件。</div>';
    return;
  }
  timeline.innerHTML = events.map((event) => `<div class="timeline-item">
    <div class="timeline-rail"></div>
    <div>
      <div class="timeline-topline">
        <span class="timeline-title">${escapeHtml(eventTitle(event))}</span>
        <span class="event-tag">${escapeHtml(event.phase || "system")}</span>
        <span class="timeline-time">${escapeHtml(formatTime(event.timestamp))}</span>
      </div>
      <div class="timeline-meta">${escapeHtml(eventMeta(event))}</div>
    </div>
  </div>`).join("");
}

function renderSummary() {
  const run = dashboardData?.run || {};
  const totals = dashboardData?.totals || {};
  const coordination = dashboardData?.coordination || {};
  const service = dashboardData?.service || {};
  document.getElementById("run-title").textContent = run.id || "MADE Deployment Run";
  document.getElementById("provider-badge").textContent = `${run.provider || "provider unknown"}${run.model ? ` · ${run.model}` : ""}`;
  document.getElementById("runtime-badge").textContent = "M5 CPU · Docker";
  document.getElementById("current-phase").textContent = phaseLabels[run.latest_phase] || run.latest_phase || "—";
  document.getElementById("current-status").textContent = formatStatus(run.status);
  document.getElementById("llm-calls").textContent = compactNumber(totals.llm_calls);
  document.getElementById("llm-tokens").textContent = `${compactNumber(totals.total_tokens)} tokens`;
  document.getElementById("interventions").textContent = compactNumber(coordination.interventions);
  document.getElementById("gate-policy").textContent = `${coordination.policy || "consistency"} gate · ${compactNumber(coordination.gate_decisions)} decisions`;
  document.getElementById("container-status").textContent = service.container_status || "—";
  document.getElementById("container-image").textContent = service.image_name || service.runtime_port_mapping || "—";
  document.getElementById("last-updated").textContent = run.updated_at ? `更新于 ${formatTime(run.updated_at)}` : "—";
  document.getElementById("coordination-mode").textContent = coordination.policy || "consistency";
}

function renderCoordination() {
  const stats = dashboardData?.coordination?.gate_stats || {};
  const labels = [
    ["interventions", "干预"],
    ["redundant", "重复"],
    ["premature", "过早"],
    ["stale", "陈旧"],
    ["stall", "停滞"],
    ["retroactive_invalidations", "回溯失效"],
  ];
  document.getElementById("gate-grid").innerHTML = labels.map(([key, label]) => `<div class="gate-item">
    <div class="gate-label">${label}</div>
    <div class="gate-value tabular">${compactNumber(stats[key] || (key === "interventions" ? dashboardData?.coordination?.interventions : 0))}</div>
  </div>`).join("");

  const events = dashboardData?.events || [];
  const actorCounts = {};
  events.forEach((event) => {
    const actor = event.actor || (event.event === "gate_decision" ? "ConsistencyGate" : "system");
    actorCounts[actor] = (actorCounts[actor] || 0) + 1;
  });
  document.getElementById("actor-summary").innerHTML = Object.entries(actorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([actor, count]) => `<div class="actor-row"><span>${escapeHtml(actor)}</span><strong class="tabular">${count}</strong></div>`)
    .join("") || '<div class="empty-state">暂无角色活动。</div>';

  const interventions = events.filter((event) => event.event === "gate_decision" && event.intervene);
  document.getElementById("intervention-summary").innerHTML = interventions.length
    ? interventions.slice(-6).reverse().map((event) => `<div class="intervention-row"><strong>${escapeHtml(event.proposed_tool || "tool")}</strong><span>${escapeHtml((event.fired || []).join(", ") || "触发门控")}</span></div>`).join("")
    : "暂无干预记录，当前所有提议均通过一致性门控。";
}

function renderOverview() {
  const events = (dashboardData?.events || []).slice(-6).reverse();
  document.getElementById("overview-event-count").textContent = `${(dashboardData?.events || []).length} events`;
  document.getElementById("overview-signals").innerHTML = events.length
    ? events.map((event) => `<div class="signal-row"><span class="signal-dot"></span><div><strong>${escapeHtml(eventTitle(event))}</strong><div class="signal-meta">${escapeHtml(eventMeta(event))}</div></div></div>`).join("")
    : '<div class="empty-state">暂无运行信号。</div>';
}

function detailRow(label, value) {
  return `<div class="detail-row"><span class="detail-key">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value || "—")}</span></div>`;
}

function renderService() {
  const service = dashboardData?.service || {};
  const evaluation = dashboardData?.evaluation || {};
  const serviceStatus = service.container_status || "not_started";
  const evaluationStatus = evaluation.status || "not_started";
  const servicePill = document.getElementById("service-status-pill");
  const evaluationPill = document.getElementById("evaluation-status-pill");
  servicePill.className = `status-pill ${statusClass(serviceStatus === "running" ? "running" : "neutral")}`;
  servicePill.textContent = serviceStatus === "running" ? "运行中" : (serviceStatus || "未启动");
  evaluationPill.className = `status-pill ${statusClass(evaluationStatus)}`;
  evaluationPill.textContent = formatStatus(evaluationStatus);
  document.getElementById("service-detail").innerHTML = [
    detailRow("容器状态", service.container_status),
    detailRow("镜像", service.image_name),
    detailRow("容器名称", service.container_name),
    detailRow("容器 ID", service.container_id),
    detailRow("端口映射", service.runtime_port_mapping),
    detailRow("API PID", service.api_pid),
    detailRow("API 文档", service.api_documentation_path),
  ].join("");
  const expected = evaluation.expected_files || [];
  const actual = evaluation.actual_files || [];
  document.getElementById("evaluation-detail").innerHTML = [
    detailRow("测试目录", evaluation.test_file_dir),
    detailRow("参考输出文件", expected.join(", ") || "未发现"),
    detailRow("实际输出文件", actual.join(", ") || "尚未生成"),
    detailRow("证据状态", evaluation.status === "not_started" ? "尚未进入 ServiceDelivery" : evaluation.status),
  ].join("");
}

function formatTestOutput(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

const DEFAULT_TEST_URL = "http://127.0.0.1:53387";

async function invokeApiTest(text, fileName) {
  const status = document.getElementById("api-test-status");
  const output = document.getElementById("api-test-output");
  const meta = document.getElementById("api-test-meta");
  const dropzone = document.getElementById("api-test-dropzone");
  const targetUrl = dashboardData?.service?.test_base_url || DEFAULT_TEST_URL;
  if (!selectedRunId || !text) {
    status.className = "status-pill failed";
    status.textContent = "缺少输入";
    output.textContent = "没有读取到可用的测试输入文件。";
    return;
  }
  dropzone.setAttribute("aria-busy", "true");
  status.className = "status-pill running";
  status.textContent = "请求中";
  output.textContent = "正在等待服务响应…";
  meta.textContent = `${fileName} · POST /predict_text · 请求中`;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target_url: targetUrl, endpoint: "/predict_text", text }),
    });
    const payload = await response.json();
    const success = response.ok && payload.ok;
    status.className = `status-pill ${success ? "completed" : "failed"}`;
    status.textContent = success ? "调用成功" : "调用失败";
    meta.textContent = `${payload.status_code ?? "网络错误"} · ${payload.duration_ms ?? 0} ms`;
    output.textContent = formatTestOutput(payload.response ?? payload.detail ?? payload);
  } catch (error) {
    status.className = "status-pill failed";
    status.textContent = "请求失败";
    meta.textContent = "Dashboard 请求异常";
    output.textContent = error.message;
  } finally {
    dropzone.removeAttribute("aria-busy");
  }
}

async function handleTestFiles(fileList) {
  const status = document.getElementById("api-test-status");
  const fileLabel = document.getElementById("api-test-file");
  const files = Array.from(fileList || []);
  const candidate = files.find((file) => /(^|\/)input\/[^/]+$/i.test(file.webkitRelativePath || file.name))
    || files.find((file) => !/(^|\/)(output|\.git)\//i.test(file.webkitRelativePath || file.name) && !/OUTPUT_FORMAT\.md$/i.test(file.name))
    || files[0];
  if (!candidate) {
    status.className = "status-pill failed";
    status.textContent = "未找到文件";
    fileLabel.textContent = "请拖入 testfile 文件或 case 目录。";
    return;
  }
  const fileName = candidate.webkitRelativePath || candidate.name;
  fileLabel.textContent = `${fileName} · ${(candidate.size / 1024).toFixed(1)} KB`;
  try {
    const text = (await candidate.text()).trim();
    await invokeApiTest(text, fileName);
  } catch (error) {
    status.className = "status-pill failed";
    status.textContent = "读取失败";
    document.getElementById("api-test-output").textContent = error.message;
  }
}

function renderAll() {
  renderSummary();
  renderPipeline();
  renderState();
  renderPhaseLedger();
  renderPhaseDetail();
  renderTimeline();
  renderCoordination();
  renderOverview();
  renderService();
}

async function loadRuns() {
  const response = await fetch("/api/runs", { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取运行记录");
  const runs = await response.json();
  const list = document.getElementById("run-list");
  if (!selectedRunId && runs.length) selectedRunId = runs[0].id;
  if (!runs.length) {
    list.innerHTML = '<div class="muted small" style="padding:8px">暂无运行记录</div>';
    return false;
  }
  list.innerHTML = runs.map((run) => `<button class="run-item ${run.id === selectedRunId ? "active" : ""}" data-run="${escapeHtml(run.id)}" type="button">
    <div class="run-item-title">${escapeHtml(run.id)}</div>
    <div class="run-item-meta"><span>${escapeHtml(phaseLabels[run.latest_phase] || run.status || "—")}</span><span>${escapeHtml(run.provider || "—")}</span></div>
  </button>`).join("");
  list.querySelectorAll("[data-run]").forEach((item) => item.addEventListener("click", () => {
    selectedRunId = item.dataset.run;
    loadSelectedRun();
  }));
  return true;
}

async function loadSelectedRun() {
  if (!selectedRunId) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}?event_limit=300`, { cache: "no-store" });
  if (!response.ok) throw new Error("无法读取运行详情");
  dashboardData = await response.json();
  renderAll();
  await loadRuns();
}

async function refresh() {
  try {
    const found = await loadRuns();
    if (found) await loadSelectedRun();
  } catch (error) {
    document.getElementById("run-title").textContent = error.message;
  }
}

function setPage(page, updateHash = true) {
  const validPages = ["overview", "state", "coordination", "service"];
  currentPage = validPages.includes(page) ? page : "overview";
  document.querySelectorAll(".page-view").forEach((view) => {
    view.hidden = view.dataset.view !== currentPage;
  });
  document.querySelectorAll(".nav-item").forEach((item) => {
    item.classList.toggle("active", item.dataset.page === currentPage);
  });
  if (updateHash && window.location.hash !== `#/${currentPage}`) window.location.hash = `/${currentPage}`;
}

document.getElementById("refresh-button").addEventListener("click", refresh);
document.getElementById("event-filter").addEventListener("change", renderTimeline);
document.getElementById("state-phase-select").addEventListener("change", (event) => {
  selectedPhase = event.target.value;
  renderPhaseDetail();
  renderPipeline();
});
const testDropzone = document.getElementById("api-test-dropzone");
const testFilePicker = document.getElementById("api-test-file-picker");
testDropzone.addEventListener("click", () => testFilePicker.click());
testDropzone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    testFilePicker.click();
  }
});
testDropzone.addEventListener("dragover", (event) => {
  event.preventDefault();
  testDropzone.classList.add("drag-over");
});
testDropzone.addEventListener("dragleave", () => testDropzone.classList.remove("drag-over"));
testDropzone.addEventListener("drop", (event) => {
  event.preventDefault();
  testDropzone.classList.remove("drag-over");
  handleTestFiles(event.dataTransfer.files);
});
testFilePicker.addEventListener("change", (event) => handleTestFiles(event.target.files));
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setPage(item.dataset.page)));
window.addEventListener("hashchange", () => setPage(window.location.hash.replace(/^#\//, ""), false));
setPage(window.location.hash.replace(/^#\//, ""), false);
refresh();
setInterval(refresh, 3000);
