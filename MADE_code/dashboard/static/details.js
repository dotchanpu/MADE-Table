const phaseLabels = { repoingest: "RepoIngest", weightresolve: "WeightResolve", dockersetup: "DockerSetUp", apiadaptation: "APIAdaptation", servicedelivery: "ServiceDelivery" };
const phaseDescriptions = {
  repoingest: "Read paper or GitHub input, clone the repository, and define the deployment task.",
  weightresolve: "Resolve, download, and validate model weights and supporting files.",
  dockersetup: "Generate a Dockerfile, build the image, and start the container.",
  apiadaptation: "Adapt the original entry point into a load / preprocess / inference / postprocess service.",
  servicedelivery: "Start the API, run tests, resolve runtime issues, and generate API documentation.",
};

let selectedRunId = new URLSearchParams(window.location.search).get("run") || null;
let dashboardData = null;
const requestedPhase = new URLSearchParams(window.location.search).get("phase");
let selectedPhase = Object.hasOwn(phaseLabels, requestedPhase) ? requestedPhase : "repoingest";
let currentPage = "overview";
let refreshing = false;
let loadedRunId = null;
let runListSignature = "";

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
function formatStatus(status) {
  return ({ completed: "Completed", running: "Running", partial: "Partial", not_started: "Pending", needs_redo: "Retry required", checkpointed: "Checkpoint saved", failed: "Failed" })[status] || status || "Unknown";
}
function formatTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function compactNumber(value) { return Number(value || 0).toLocaleString("en-GB"); }
function phaseByName(name) {
  return (dashboardData?.phases || []).find((phase) => phase.phase === name) || { phase: name, status: "not_started", present_outputs: [], missing_outputs: [] };
}

function phaseNode(name, index) {
  const phase = phaseByName(name);
  const status = phase.status || "not_started";
  return `<button class="phase-node ${escapeHtml(status)}${selectedPhase === name ? " selected" : ""}" data-phase="${escapeHtml(name)}" type="button" aria-pressed="${selectedPhase === name}">
    <div class="phase-index">0${index}</div><div class="phase-name">${escapeHtml(phaseLabels[name] || name)}</div>
    <div class="phase-status"><span class="status-dot"></span>${escapeHtml(formatStatus(status))}</div></button>`;
}
function renderPipeline() {
  const pipeline = document.getElementById("pipeline");
  pipeline.innerHTML = [phaseNode("repoingest", 1), '<div class="phase-connector" aria-hidden="true"></div>',
    `<div class="parallel-group"><div class="parallel-caption">Parallel</div><div class="parallel-lane">${phaseNode("weightresolve", 2)}${phaseNode("dockersetup", 3)}</div></div>`,
    '<div class="phase-connector" aria-hidden="true"></div>', phaseNode("apiadaptation", 4),
    '<div class="phase-connector" aria-hidden="true"></div>', phaseNode("servicedelivery", 5)].join("");
  pipeline.querySelectorAll("[data-phase]").forEach((node) => node.addEventListener("click", () => {
    selectedPhase = node.dataset.phase;
    renderPipeline();
    renderPhaseDetail();
  }));
}

function phaseDetailMarkup(phase) {
  const present = phase.present_outputs || [];
  const missing = phase.missing_outputs || [];
  const outputs = [...present.map((key) => `<div class="output-row present"><span class="output-check">✓</span><code>${escapeHtml(key)}</code></div>`),
    ...missing.map((key) => `<div class="output-row missing"><span class="output-check">·</span><code>${escapeHtml(key)}</code></div>`)].join("");
  return `<div class="detail-list"><div class="detail-row"><span class="detail-key">Phase goal</span><span class="detail-value">${escapeHtml(phaseDescriptions[phase.phase] || "—")}</span></div>
    <div class="detail-row"><span class="detail-key">Produced</span><span class="detail-value">${present.length} artifacts</span></div>
    <div class="detail-row"><span class="detail-key">Missing outputs</span><span class="detail-value">${missing.length} artifacts</span></div></div>
    <div class="eyebrow output-heading">REQUIRED OUTPUTS</div><div class="output-list">${outputs || '<div class="muted small">No required outputs recorded.</div>'}</div>`;
}
function renderPhaseDetail() {
  const phase = phaseByName(selectedPhase);
  const select = document.getElementById("state-phase-select");
  if (select) select.value = selectedPhase;
  const title = phaseLabels[selectedPhase] || selectedPhase;
  document.getElementById("phase-detail-title").textContent = title;
  const status = document.getElementById("phase-detail-status");
  status.className = `status-pill ${phase.status || "neutral"}`;
  status.textContent = formatStatus(phase.status);
  document.getElementById("phase-detail").innerHTML = phaseDetailMarkup(phase);
  document.getElementById("overview-phase-title").textContent = title;
  const overviewStatus = document.getElementById("overview-phase-status");
  overviewStatus.className = `status-pill ${phase.status || "neutral"}`;
  overviewStatus.textContent = formatStatus(phase.status);
  document.getElementById("overview-phase-detail").innerHTML = phaseDetailMarkup(phase);
}

function renderState() {
  const rows = dashboardData?.variables || [];
  document.getElementById("state-count").textContent = `${rows.length} variables`;
  document.getElementById("state-table").innerHTML = rows.length ? rows.map((row) => `<tr>
    <td>${escapeHtml(row.key)}</td><td>${escapeHtml(phaseLabels[row.phase] || row.phase || "—")}</td>
    <td>${escapeHtml(row.value || "—")}</td><td>${escapeHtml(row.producer_tool || row.storage || "checkpoint")}</td></tr>`).join("")
    : '<tr><td colspan="4" class="muted">No shared-state snapshot for this run.</td></tr>';
  document.getElementById("phase-ledger").innerHTML = (dashboardData?.phases || []).map((phase) => `<tr>
    <td>${escapeHtml(phaseLabels[phase.phase] || phase.phase)}</td><td><span class="status-pill ${escapeHtml(phase.status)}">${escapeHtml(formatStatus(phase.status))}</span></td>
    <td>${escapeHtml((phase.present_outputs || []).join(", ") || "—")}</td><td>${escapeHtml((phase.missing_outputs || []).join(", ") || "—")}</td></tr>`).join("")
    || '<tr><td colspan="4" class="muted">No phase ledger yet.</td></tr>';
}

function eventTitle(event) {
  if (event.event === "llm_call") return `${event.actor || "LLM"} · ${event.call_type || "query"}`;
  if (event.event === "step_end") return `${event.actor || "tool"} · ${event.step || "step"}`;
  if (event.event === "gate_decision") return event.intervene ? "Consistency gate · intervention" : "Consistency gate · passed";
  if (event.event === "variable_stored") return `Shared state · ${event.variable || "variable"}`;
  if (event.event === "phase_end") return `Phase complete · ${phaseLabels[event.phase] || event.phase}`;
  if (event.event === "gate_stats") return "Consistency gate · statistics";
  if (event.event === "pipeline_end") return "Pipeline complete";
  return event.event || "system";
}
function eventMeta(event) {
  if (event.event === "llm_call") return `${event.model || event.backend || "model"} · ${compactNumber(event.total_tokens)} tokens · ${Number(event.duration_s || 0).toFixed(2)}s`;
  if (event.event === "step_end") return `${phaseLabels[event.phase] || event.phase || "unknown"} · ${Number(event.duration_s || 0).toFixed(2)}s`;
  if (event.event === "gate_decision") return `${event.proposed_tool || "tool"} · ${(event.fired || []).join(", ") || "No conditions triggered"}`;
  if (event.event === "variable_stored") return `${event.storage || "state"} · ${event.value_summary || "Written"}`;
  if (event.event === "phase_end") return `${Number(event.duration_s || 0).toFixed(2)}s · ${event.llm_calls || 0} LLM calls`;
  if (event.event === "gate_stats") return `interventions: ${event.interventions || 0} · stall: ${event.stall || 0}`;
  return phaseLabels[event.phase] || event.phase || "system";
}
function renderTimeline() {
  const filter = document.getElementById("event-filter").value;
  const events = (dashboardData?.events || []).filter((event) => filter === "all" || event.event === filter).slice().reverse();
  document.getElementById("timeline").innerHTML = events.length ? events.map((event) => `<div class="timeline-item"><div class="timeline-rail"></div><div>
    <div class="timeline-topline"><span class="timeline-title">${escapeHtml(eventTitle(event))}</span><span class="event-tag">${escapeHtml(phaseLabels[event.phase] || event.phase || "system")}</span><time class="timeline-time">${escapeHtml(formatTime(event.timestamp))}</time></div>
    <div class="timeline-meta">${escapeHtml(eventMeta(event))}</div></div></div>`).join("") : '<div class="empty-state">No matching events.</div>';
}

function renderSummary() {
  const run = dashboardData?.run || {};
  const totals = dashboardData?.totals || {};
  const coordination = dashboardData?.coordination || {};
  const service = dashboardData?.service || {};
  const runTitle = document.getElementById("run-title");
  runTitle.textContent = run.id || "MADE Deployment Run";
  runTitle.title = runTitle.textContent;
  const providerBadge = document.getElementById("provider-badge");
  providerBadge.textContent = `${run.provider || "provider unknown"}${run.model ? ` · ${run.model}` : ""}`;
  providerBadge.title = providerBadge.textContent;
  document.getElementById("current-phase").textContent = phaseLabels[run.latest_phase] || run.latest_phase || "—";
  document.getElementById("current-status").textContent = formatStatus(run.status);
  document.getElementById("llm-calls").textContent = compactNumber(totals.llm_calls);
  document.getElementById("llm-tokens").textContent = `${compactNumber(totals.total_tokens)} tokens`;
  document.getElementById("interventions").textContent = compactNumber(coordination.interventions);
  document.getElementById("gate-policy").textContent = `${coordination.policy || "consistency"} gate · ${compactNumber(coordination.gate_decisions)} decisions`;
  document.getElementById("container-status").textContent = service.container_status || "—";
  document.getElementById("container-image").textContent = service.image_name || service.runtime_port_mapping || "—";
  document.getElementById("last-updated").textContent = run.updated_at ? `Updated ${formatTime(run.updated_at)}` : "—";
  document.getElementById("coordination-mode").textContent = coordination.policy || "consistency";
}
function renderCoordination() {
  const stats = dashboardData?.coordination?.gate_stats || {};
  const labels = [["interventions", "Interventions"], ["redundant", "Redundant"], ["premature", "Premature"], ["stale", "Stale"], ["stall", "Stall"], ["retroactive_invalidations", "Retroactive invalidations"]];
  document.getElementById("gate-grid").innerHTML = labels.map(([key, label]) => `<div class="gate-item"><div class="gate-label">${label}</div><div class="gate-value tabular">${compactNumber(stats[key] || (key === "interventions" ? dashboardData?.coordination?.interventions : 0))}</div></div>`).join("");
  const actorCounts = {};
  (dashboardData?.events || []).forEach((event) => { const actor = event.actor || (event.event === "gate_decision" ? "ConsistencyGate" : "system"); actorCounts[actor] = (actorCounts[actor] || 0) + 1; });
  document.getElementById("actor-summary").innerHTML = Object.entries(actorCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([actor, count]) => `<div class="actor-row"><span>${escapeHtml(actor)}</span><strong>${count}</strong></div>`).join("") || '<div class="empty-state">No actor activity yet.</div>';
  const interventions = (dashboardData?.events || []).filter((event) => event.event === "gate_decision" && event.intervene);
  document.getElementById("intervention-summary").innerHTML = interventions.length ? interventions.slice(-8).reverse().map((event) => `<div class="intervention-row"><strong>${escapeHtml(event.proposed_tool || "tool")}</strong><span>${escapeHtml((event.fired || []).join(", ") || "Gate triggered")}</span></div>`).join("") : '<div class="empty-state">No interventions. All current proposals passed the consistency gate.</div>';
}
function renderOverview() {
  const events = (dashboardData?.events || []).slice(-6).reverse();
  document.getElementById("overview-event-count").textContent = `${(dashboardData?.events || []).length} events`;
  document.getElementById("overview-signals").innerHTML = events.length ? events.map((event) => `<div class="signal-row"><span class="signal-dot"></span><div><strong>${escapeHtml(eventTitle(event))}</strong><div class="signal-meta">${escapeHtml(eventMeta(event))}</div></div></div>`).join("") : '<div class="empty-state">No runtime signals yet.</div>';
}
function detailRow(label, value) { return `<div class="detail-row"><span class="detail-key">${escapeHtml(label)}</span><span class="detail-value">${escapeHtml(value || "—")}</span></div>`; }
function renderService() {
  const service = dashboardData?.service || {};
  const evaluation = dashboardData?.evaluation || {};
  const servicePill = document.getElementById("service-status-pill");
  servicePill.className = `status-pill ${service.container_status === "running" ? "running" : "neutral"}`;
  servicePill.textContent = service.container_status === "running" ? "Running" : (service.container_status || "Not started");
  const evaluationPill = document.getElementById("evaluation-status-pill");
  evaluationPill.className = `status-pill ${evaluation.status || "neutral"}`;
  evaluationPill.textContent = formatStatus(evaluation.status);
  document.getElementById("service-detail").innerHTML = [detailRow("Container status", service.container_status), detailRow("Image", service.image_name), detailRow("Container name", service.container_name), detailRow("Container ID", service.container_id), detailRow("Port mapping", service.runtime_port_mapping), detailRow("API PID", service.api_pid), detailRow("API documentation", service.api_documentation_path)].join("");
  document.getElementById("evaluation-detail").innerHTML = [detailRow("Test directory", evaluation.test_file_dir), detailRow("Expected output files", (evaluation.expected_files || []).join(", ") || "Not found"), detailRow("Actual output files", (evaluation.actual_files || []).join(", ") || "Not produced yet"), detailRow("Evidence status", evaluation.status === "not_started" ? "ServiceDelivery has not started" : evaluation.status)].join("");
}

async function invokeApiTest(text, fileName) {
  const status = document.getElementById("api-test-status");
  const output = document.getElementById("api-test-output");
  const meta = document.getElementById("api-test-meta");
  const dropzone = document.getElementById("api-test-dropzone");
  const targetUrl = dashboardData?.service?.test_base_url || "http://127.0.0.1:53387";
  if (!selectedRunId || !text) { status.className = "status-pill failed"; status.textContent = "Missing input"; output.textContent = "No usable test input file was found."; return; }
  dropzone.setAttribute("aria-busy", "true"); status.className = "status-pill running"; status.textContent = "Requesting"; output.textContent = "Waiting for service response…"; meta.textContent = `${fileName} · POST /predict_text · Requesting`;
  try {
    const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}/invoke`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_url: targetUrl, endpoint: "/predict_text", text }) });
    const payload = await response.json();
    const inferenceStatus = payload.inference_status?.status;
    const success = response.ok && payload.ok && inferenceStatus !== "invalid";
    status.className = `status-pill ${success ? "completed" : "failed"}`;
    status.textContent = success ? "Inference succeeded" : (inferenceStatus === "invalid" ? "Invalid model result" : "Call failed");
    meta.textContent = `${payload.status_code ?? "Network error"} · ${payload.duration_ms ?? 0} ms${payload.inference_status?.message ? ` · ${payload.inference_status.message}` : ""}`;
    output.textContent = JSON.stringify(payload.response ?? payload.detail ?? payload, null, 2);
  } catch (error) { status.className = "status-pill failed"; status.textContent = "Request failed"; meta.textContent = "Dashboard request error"; output.textContent = error.message; }
  finally { dropzone.removeAttribute("aria-busy"); }
}
async function handleTestFiles(fileList) {
  const files = Array.from(fileList || []);
  const candidate = files.find((file) => /(^|\/)input\/[^/]+$/i.test(file.webkitRelativePath || file.name)) || files.find((file) => !/(^|\/)(output|\.git)\//i.test(file.webkitRelativePath || file.name) && !/OUTPUT_FORMAT\.md$/i.test(file.name)) || files[0];
  const status = document.getElementById("api-test-status");
  if (!candidate) { status.className = "status-pill failed"; status.textContent = "No file found"; return; }
  const name = candidate.webkitRelativePath || candidate.name;
  document.getElementById("api-test-file").textContent = `${name} · ${(candidate.size / 1024).toFixed(1)} KB`;
  try { await invokeApiTest((await candidate.text()).trim(), name); }
  catch (error) { status.className = "status-pill failed"; status.textContent = "Read failed"; document.getElementById("api-test-output").textContent = error.message; }
}

function renderAll() { renderSummary(); renderPipeline(); renderState(); renderPhaseDetail(); renderTimeline(); renderCoordination(); renderOverview(); renderService(); }
function setPage(page, updateHash = true) {
  const validPages = ["overview", "state", "coordination", "service"];
  currentPage = validPages.includes(page) ? page : "overview";
  document.querySelectorAll(".page-view").forEach((view) => { view.hidden = view.dataset.view !== currentPage; });
  document.querySelectorAll(".nav-item").forEach((item) => {
    const active = item.dataset.page === currentPage;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
  const titles = { overview: "Overview", state: "Shared state", coordination: "Agent coordination", service: "Service & tests" };
  document.title = `MADE · ${titles[currentPage]}`;
  if (updateHash && window.location.hash !== `#/${currentPage}`) window.location.hash = `/${currentPage}`;
}
async function loadRuns() {
  const response = await fetch("/api/runs", { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load runs");
  const runs = await response.json();
  runs.sort((a, b) => (Date.parse(b.updated_at || "") || 0) - (Date.parse(a.updated_at || "") || 0));
  if (!runs.some((run) => run.id === selectedRunId)) selectedRunId = runs[0]?.id || null;
  const list = document.getElementById("run-list");
  const signature = JSON.stringify(runs.map(({ id, latest_phase, status, provider }) => [id, latest_phase, status, provider]));
  if (signature !== runListSignature) {
    list.innerHTML = runs.length ? runs.map((run) => `<button class="run-item" data-run="${escapeHtml(run.id)}" title="${escapeHtml(run.id)}" type="button"><div class="run-item-title">${escapeHtml(run.id)}</div><div class="run-item-meta"><span>${escapeHtml(phaseLabels[run.latest_phase] || run.status || "—")}</span><span>${escapeHtml(run.provider || "—")}</span></div></button>`).join("") : '<div class="muted small">No runs available</div>';
    list.querySelectorAll("[data-run]").forEach((item) => item.addEventListener("click", () => { selectedRunId = item.dataset.run; refresh(); }));
    document.getElementById("mobile-run-select").innerHTML = runs.length ? runs.map((run) => `<option value="${escapeHtml(run.id)}">${escapeHtml(run.id)}</option>`).join("") : '<option value="">No runs available</option>';
    runListSignature = signature;
  }
  list.querySelectorAll("[data-run]").forEach((item) => {
    const active = item.dataset.run === selectedRunId;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  document.getElementById("mobile-run-select").value = selectedRunId || "";
  return Boolean(runs.length);
}
async function loadSelectedRun() {
  if (!selectedRunId) return;
  const response = await fetch(`/api/runs/${encodeURIComponent(selectedRunId)}?event_limit=1000`, { cache: "no-store" });
  if (!response.ok) throw new Error("Unable to load run details");
  dashboardData = await response.json();
  if (loadedRunId !== selectedRunId) {
    if (loadedRunId !== null || !Object.hasOwn(phaseLabels, requestedPhase)) selectedPhase = dashboardData.run.latest_phase || "repoingest";
    loadedRunId = selectedRunId;
  }
  renderAll();
  const nextUrl = `/details?run=${encodeURIComponent(selectedRunId)}&phase=${encodeURIComponent(selectedPhase)}${window.location.hash || "#/overview"}`;
  if (`${window.location.pathname}${window.location.search}${window.location.hash}` !== nextUrl) window.history.replaceState(null, "", nextUrl);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  const refreshButton = document.getElementById("refresh-button");
  refreshButton.disabled = true;
  refreshButton.setAttribute("aria-busy", "true");
  try { const found = await loadRuns(); if (found) await loadSelectedRun(); else document.getElementById("run-title").textContent = "No runs available"; }
  catch (error) { document.getElementById("run-title").textContent = error.message; }
  finally { refreshing = false; refreshButton.disabled = false; refreshButton.removeAttribute("aria-busy"); }
}

document.getElementById("refresh-button").addEventListener("click", refresh);
document.getElementById("mobile-run-select").addEventListener("change", (event) => { selectedRunId = event.target.value || null; refresh(); });
document.getElementById("event-filter").addEventListener("change", renderTimeline);
document.getElementById("state-phase-select").addEventListener("change", (event) => { selectedPhase = event.target.value; renderPhaseDetail(); renderPipeline(); });
const dropzone = document.getElementById("api-test-dropzone");
const picker = document.getElementById("api-test-file-picker");
dropzone.addEventListener("click", () => picker.click());
dropzone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); picker.click(); } });
dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("drag-over"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag-over"));
dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("drag-over"); handleTestFiles(event.dataTransfer.files); });
picker.addEventListener("change", (event) => handleTestFiles(event.target.files));
document.querySelectorAll(".nav-item").forEach((item) => item.addEventListener("click", () => setPage(item.dataset.page)));
document.getElementById("return-dashboard").addEventListener("click", () => { window.location.assign(`/${selectedRunId ? `?run=${encodeURIComponent(selectedRunId)}` : ""}`); });
window.addEventListener("hashchange", () => setPage(window.location.hash.replace(/^#\//, ""), false));
setPage(window.location.hash.replace(/^#\//, ""), false);
refresh();
window.setInterval(refresh, 3000);
