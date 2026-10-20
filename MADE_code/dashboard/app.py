"""Web dashboard for MADE runs and deployed-service smoke tests.

The dashboard deliberately consumes the pipeline's existing JSONL logs and
parallel checkpoint.  It does not execute deployment tools or expose prompts
and credentials to the browser.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request as UrlRequest, urlopen

from fastapi import Body, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
import yaml


MADE_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = MADE_ROOT.parent
LOG_ROOT = Path(os.environ.get("MADE_DASHBOARD_LOG_ROOT", MADE_ROOT / "logs")).resolve()
STATIC_ROOT = Path(__file__).resolve().parent / "static"
PHASE_CONFIG_PATH = MADE_ROOT / "agent" / "phase_manager_prompt.json"


def _load_phase_config() -> List[Dict[str, Any]]:
    try:
        payload = json.loads(PHASE_CONFIG_PATH.read_text(encoding="utf-8"))
        return payload.get("available_phases", [])
    except (OSError, json.JSONDecodeError):
        return []


PHASE_CONFIG = _load_phase_config()
PHASE_NAMES = [item.get("name") for item in PHASE_CONFIG if item.get("name")]
PHASE_LABELS = {
    "repoingest": "RepoIngest",
    "weightresolve": "WeightResolve",
    "dockersetup": "DockerSetUp",
    "apiadaptation": "APIAdaptation",
    "servicedelivery": "ServiceDelivery",
}
PHASE_DESCRIPTIONS = {item.get("name"): item.get("description", "") for item in PHASE_CONFIG}


def _docker_work_dir() -> Path:
    try:
        config = yaml.safe_load((MADE_ROOT / "config" / "global.yaml").read_text(encoding="utf-8")) or {}
        work_dir = (config.get("docker_setting") or {}).get("work_dir") or "/workspace"
        return Path(str(work_dir))
    except (OSError, yaml.YAMLError, AttributeError):
        return Path("/workspace")


app = FastAPI(title="MADE Dashboard", version="0.1.0")
app.mount("/static", StaticFiles(directory=str(STATIC_ROOT)), name="static")


def _json_load(path: Path, default: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return default


def _safe_run_id(run_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", run_id):
        raise HTTPException(status_code=400, detail="invalid run id")
    return run_id


def _run_dir(run_id: str) -> Path:
    path = (LOG_ROOT / _safe_run_id(run_id)).resolve()
    if path.parent != LOG_ROOT or not path.is_dir():
        raise HTTPException(status_code=404, detail="run not found")
    return path


def _run_updated_at(run_dir: Path) -> str:
    """Use the latest file write, not directory creation time.

    A run directory is created at startup, so ``run_dir.stat().st_mtime`` can
    make an old, long-running job look older than a newer job that finished
    quickly. The event log is the authoritative activity clock.
    """
    candidates = [
        path for path in (
            run_dir / "calls.jsonl",
            run_dir / "summary.txt",
            run_dir / "variable_store_after_parallel.json",
        ) if path.is_file()
    ]
    if not candidates:
        candidates = [run_dir]
    latest_mtime = max(path.stat().st_mtime for path in candidates)
    return datetime.fromtimestamp(latest_mtime).isoformat()


def _redact(value: Any) -> str:
    text = str(value or "")
    text = re.sub(r"sk-[A-Za-z0-9_-]{12,}", "[redacted-key]", text)
    text = re.sub(r"(?i)(bearer\s+)[A-Za-z0-9._-]+", r"\1[redacted]", text)
    text = re.sub(r"(?i)(api[_-]?key\s*[:=]\s*)[^\s,]+", r"\1[redacted]", text)
    return text


def _preview(value: Any, limit: int = 220) -> str:
    if value is None:
        return "null"
    if isinstance(value, dict):
        keys = list(value.keys())[:10]
        return "dict(keys={})".format(", ".join(str(key) for key in keys))
    if isinstance(value, list):
        return "list(len={})".format(len(value))
    text = " ".join(_redact(value).split())
    return text if len(text) <= limit else text[: limit - 3] + "..."


def _read_events(run_dir: Path) -> List[Dict[str, Any]]:
    path = run_dir / "calls.jsonl"
    events: List[Dict[str, Any]] = []
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return events

    for index, line in enumerate(lines):
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_name = raw.get("event", "unknown")
        item: Dict[str, Any] = {
            "id": index + 1,
            "event": event_name,
            "timestamp": raw.get("timestamp"),
            "phase": raw.get("phase", "unknown"),
        }
        if event_name == "llm_call":
            item.update({
                "actor": raw.get("role", "llm"),
                "call_type": raw.get("call_type"),
                "backend": raw.get("backend"),
                "model": raw.get("model"),
                "prompt_tokens": raw.get("prompt_tokens", 0),
                "completion_tokens": raw.get("completion_tokens", 0),
                "total_tokens": raw.get("total_tokens", 0),
                "duration_s": raw.get("duration_s", 0),
                "response_preview": _preview(raw.get("response", ""), 360),
            })
        elif event_name == "step_end":
            item.update({
                "actor": raw.get("role", "tool"),
                "step": raw.get("step"),
                "duration_s": raw.get("duration_s", 0),
            })
        elif event_name == "phase_end":
            item.update({
                "actor": "system",
                "duration_s": raw.get("duration_s", 0),
                "llm_calls": raw.get("llm_calls", 0),
                "prompt_tokens": raw.get("prompt_tokens", 0),
                "completion_tokens": raw.get("completion_tokens", 0),
            })
        elif event_name == "gate_decision":
            item.update({
                "actor": "gate",
                "em_turn": raw.get("em_turn"),
                "proposed_tool": raw.get("proposed_tool"),
                "current_phase_status": raw.get("current_phase_status"),
                "policy": raw.get("policy"),
                "fired": raw.get("fired", []),
                "intervene": raw.get("intervene", False),
                "stall_fired": raw.get("stall_fired", False),
            })
        elif event_name == "gate_stats":
            item.update({"actor": "gate", **{key: raw.get(key, 0) for key in (
                "interventions", "redundant", "premature", "stale", "stall",
                "always", "random", "uncertainty", "retroactive_invalidations",
            )}})
        elif event_name == "variable_stored":
            item.update({
                "actor": "state",
                "variable": raw.get("variable"),
                "storage": raw.get("storage"),
                "producer_tool": raw.get("producer_tool"),
                "value_type": raw.get("value_type"),
                "value_summary": _preview(raw.get("value_summary", "")),
            })
        elif event_name == "pipeline_end":
            item.update({
                "actor": "system",
                "total_llm_calls": raw.get("total_llm_calls", 0),
                "total_tokens": raw.get("total_tokens", 0),
                "total_llm_time_s": raw.get("total_llm_time_s", 0),
            })
        else:
            item["actor"] = raw.get("role", "system")
        events.append(item)
    return events


def _find_nested_deployment_state(value: Any) -> Optional[List[Dict[str, Any]]]:
    if isinstance(value, dict):
        candidate = value.get("deployment_state")
        if isinstance(candidate, list):
            return candidate
        for child in value.values():
            found = _find_nested_deployment_state(child)
            if found is not None:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _find_nested_deployment_state(child)
            if found is not None:
                return found
    return None


def _phase_state(
    variables: Dict[str, Any],
    checkpoint: Dict[str, Any],
    events: Iterable[Dict[str, Any]],
    pipeline_done: bool = False,
) -> List[Dict[str, Any]]:
    events = list(events)
    stored_keys = set(variables)
    stored_keys.update(event.get("variable") for event in events if event.get("event") == "variable_stored")
    checkpoint_state = _find_nested_deployment_state(checkpoint)
    last_phase_end = {
        name: max(
            (int(event.get("id") or 0) for event in events
             if event.get("event") == "phase_end" and event.get("phase") == name),
            default=0,
        )
        for name in PHASE_NAMES
    }

    # A phase is live when its event stream has activity after its most recent
    # phase_end. This also handles WeightResolve and DockerSetUp running in
    # parallel: both remain visibly "Running" until their own phase_end event.
    active_phases = {
        name for name in PHASE_NAMES
        if any(
            event.get("phase") == name
            and event.get("event") != "phase_end"
            and int(event.get("id") or 0) > last_phase_end[name]
            for event in events
        )
    }
    result: List[Dict[str, Any]] = []
    for phase in PHASE_CONFIG:
        name = phase.get("name")
        required = phase.get("required_outputs", []) or []
        from_checkpoint = next((item for item in checkpoint_state or [] if item.get("phase") == name), None)
        present = [key for key in required if key in stored_keys]
        missing = [key for key in required if key not in present]
        phase_end = any(event.get("event") == "phase_end" and event.get("phase") == name for event in events)
        checkpoint_needs_redo = bool(from_checkpoint and from_checkpoint.get("status") == "needs_redo" and not phase_end)
        if checkpoint_needs_redo:
            status = "needs_redo"
            present = list(from_checkpoint.get("present_outputs", []) or [])
            missing = list(from_checkpoint.get("missing_outputs", []) or [])
        elif required and not missing:
            status = "completed"
        elif phase_end and not required:
            status = "completed"
        elif present:
            status = "partial"
        elif from_checkpoint:
            # The parallel checkpoint is intentionally written before the
            # post-parallel phases run. Preserve its status only when the
            # final event stream has no newer evidence for this phase.
            status = from_checkpoint.get("status", "not_started")
            present = list(from_checkpoint.get("present_outputs", []) or [])
            missing = list(from_checkpoint.get("missing_outputs", []) or [])
        else:
            status = "not_started"
        if not pipeline_done and name in active_phases:
            status = "running"
        result.append({
            "phase": name,
            "status": status,
            "present_outputs": present,
            "missing_outputs": missing,
        })
    return result


def _producer_map(events: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    result: Dict[str, Dict[str, Any]] = {}
    for event in events:
        if event.get("event") == "variable_stored" and event.get("variable"):
            result[event["variable"]] = {
                "phase": event.get("phase"),
                "tool": event.get("producer_tool"),
                "storage": event.get("storage"),
                "value_summary": event.get("value_summary"),
            }
    return result


def _variables(checkpoint: Dict[str, Any], events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    values = checkpoint.get("variable_store", {}) or {}
    producers = _producer_map(events)
    fallback = {
        "pdf_path": "input", "test_file_dir": "input", "github_link": "repoingest",
        "repo_root": "repoingest", "task": "repoingest", "cleaned_readmes_path": "repoingest",
        "pending_weight_candidates_path": "weightresolve", "downloaded_weight_path": "weightresolve",
        "weights_path": "weightresolve", "weights_dir": "weightresolve",
        "dockerfile_path": "dockersetup", "image_name": "dockersetup",
        "container_name": "dockersetup", "container_id": "dockersetup",
        "runtime_port_mapping": "dockersetup", "entry_point_path": "apiadaptation",
        "run_command": "apiadaptation", "fastapiapp_dir": "apiadaptation",
        "service_pipeline_path": "apiadaptation", "input_schema": "apiadaptation",
        "api_pid": "servicedelivery", "api_documentation_path": "servicedelivery",
    }
    keys = set(values)
    keys.update(producers)
    rows = []
    for key in sorted(keys):
        meta = producers.get(key, {})
        phase = meta.get("phase") or fallback.get(key, "unknown")
        raw_value = values.get(key)
        rows.append({
            "key": key,
            "phase": phase,
            "producer_tool": meta.get("tool"),
            "storage": meta.get("storage", "checkpoint"),
            "value_type": type(raw_value).__name__ if raw_value is not None else "event_only",
            "value": _preview(raw_value if raw_value is not None else meta.get("value_summary"), 280),
            "available": key in keys,
        })
    return rows


def _docker_status(container_id: Optional[str]) -> Optional[str]:
    if not container_id:
        return None
    try:
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Status}}", str(container_id)],
            capture_output=True, text=True, timeout=2,
        )
        if result.returncode == 0:
            return result.stdout.strip() or "unknown"
    except (OSError, subprocess.SubprocessError):
        pass
    return "unavailable"


def _service_base_url(value: Any) -> Optional[str]:
    """Convert a stored host-port mapping into a browser-testable base URL."""
    if not value:
        return None
    text = str(value).strip()
    match = re.search(r"(?:(?:127\.0\.0\.1|localhost):)?(\d+):\d+$", text)
    if not match:
        match = re.search(r"(?:127\.0\.0\.1|localhost):(?P<port>\d+)$", text)
    if not match:
        return None
    port = match.group("port") if "port" in match.groupdict() else match.group(1)
    return f"http://127.0.0.1:{port}"


def _validate_test_target(value: Any, endpoint: Any) -> str:
    base = str(value or "").strip().rstrip("/")
    parsed = urlparse(base)
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise HTTPException(status_code=400, detail="Test URLs must use a local localhost service")
    path = str(endpoint or "/predict_text")
    if path not in {"/predict_text", "/predict"}:
        raise HTTPException(status_code=400, detail="Unsupported test endpoint")
    return f"{base}{path}"


def _inference_status(response_payload: Any) -> Dict[str, Any]:
    """Separate reachable API status from meaningful model inference status."""
    if not isinstance(response_payload, dict):
        return {"status": "unknown", "message": "The service did not return a JSON object"}
    if not response_payload.get("success"):
        return {"status": "failed", "message": str(response_payload.get("error") or "Inference failed")}
    result = response_payload.get("result")
    if not isinstance(result, dict):
        return {"status": "unknown", "message": "The service returned no structured inference result"}
    model_status = result.get("model_status")
    if isinstance(model_status, dict) and model_status.get("weights_loaded") is False:
        return {"status": "invalid", "message": "Model weights were not loaded successfully"}
    predictions = result.get("predictions_top5")
    tokens = [
        str(item.get("token_str") or "").strip().lower()
        for item in predictions
        if isinstance(item, dict) and str(item.get("token_str") or "").strip()
    ] if isinstance(predictions, list) else []
    if tokens and all(token in {"[unk]", "<unk>", "unk"} for token in tokens):
        return {"status": "invalid", "message": "All top-k predictions are [UNK]"}
    return {"status": "valid", "message": "The model completed valid inference"}


def _run_payload(run_dir: Path, event_limit: int = 240) -> Dict[str, Any]:
    run_id = run_dir.name
    events = _read_events(run_dir)
    checkpoint = _json_load(run_dir / "variable_store_after_parallel.json", {})
    variables = checkpoint.get("variable_store", {}) or {}
    # The parallel checkpoint is written before APIAdaptation and
    # ServiceDelivery. Merge later variable outputs from the event stream so
    # the dashboard reflects the final run rather than the checkpoint view.
    variables = dict(variables)
    for event in events:
        if event.get("event") == "variable_stored" and event.get("variable"):
            variables[event["variable"]] = event.get("value_summary")
    pipeline_end = next((event for event in reversed(events) if event.get("event") == "pipeline_end"), None)
    states = _phase_state(variables, checkpoint, events, pipeline_done=bool(pipeline_end))
    phase_end_events = [event for event in events if event.get("event") == "phase_end"]
    gate_events = [event for event in events if event.get("event") == "gate_decision"]
    gate_stats = [event for event in events if event.get("event") == "gate_stats"]
    latest = events[-1] if events else None
    latest_phase = next((event.get("phase") for event in reversed(events) if event.get("phase") in PHASE_NAMES), None)
    llm_events = [event for event in events if event.get("event") == "llm_call"]
    provider = next((event.get("backend") for event in reversed(llm_events) if event.get("backend")), None)
    model = next((event.get("model") for event in reversed(llm_events) if event.get("model")), None)
    run_status = "completed" if pipeline_end else ("running" if latest else "not_started")
    if not events and checkpoint:
        run_status = "checkpointed"

    variable_rows = _variables(checkpoint, events)
    container_id = variables.get("container_id")
    test_dir = variables.get("test_file_dir")
    test_path = Path(str(test_dir)) if test_dir else None
    expected_files = []
    actual_files = []
    if test_path and test_path.is_dir():
        expected_files = sorted(
            str(path.relative_to(test_path))
            for path in test_path.glob("**/output/**/*")
            if path.is_file()
        )
    run_test_output_root = run_dir / "test_outputs"
    if run_test_output_root.is_dir():
        actual_files = sorted(
            str(path.relative_to(run_dir))
            for path in run_test_output_root.glob("**/inference_output_*/response_payload.json")
            if path.is_file()
        )
    elif test_path and test_path.is_dir():
        # Preserve visibility for historical runs created before validation
        # artifacts were moved out of case directories.
        actual_files = sorted(
            str(path.relative_to(test_path))
            for path in test_path.glob("**/inference_output_*/response_payload.json")
            if path.is_file()
        )

    totals = {
        "llm_calls": len(llm_events),
        "total_tokens": sum(int(event.get("total_tokens") or 0) for event in llm_events),
        "phase_events": len(phase_end_events),
        "gate_decisions": len(gate_events),
        "gate_stats": len(gate_stats),
    }
    return {
        "run": {
            "id": run_id,
            "status": run_status,
            "latest_phase": latest_phase,
            "provider": provider,
            "model": model,
            "backend": provider,
            "updated_at": _run_updated_at(run_dir),
            "log_dir": str(run_dir),
        },
        "phases": states,
        "variables": variable_rows,
        "artifacts": variable_rows,
        "events": events[-event_limit:],
        "coordination": {
            "policy": next((event.get("policy") for event in reversed(gate_events) if event.get("policy")), "consistency"),
            "gate_stats": gate_stats[-1] if gate_stats else {},
            "gate_decisions": len(gate_events),
            "interventions": sum(1 for event in gate_events if event.get("intervene")),
        },
        "service": {
            "repo_root": variables.get("repo_root"),
            "container_work_dir": str(_docker_work_dir()),
            "container_id": container_id,
            "container_status": _docker_status(container_id),
            "container_name": variables.get("container_name"),
            "image_name": variables.get("image_name"),
            "runtime_port_mapping": variables.get("runtime_port_mapping"),
            "api_pid": variables.get("api_pid"),
            "api_documentation_path": variables.get("api_documentation_path"),
            "test_base_url": _service_base_url(variables.get("runtime_port_mapping")),
        },
        "evaluation": {
            "test_file_dir": str(test_path) if test_path else None,
            "expected_files": expected_files,
            "actual_files": actual_files,
            "status": "completed" if pipeline_end else ("pending" if variables.get("api_pid") else "not_started"),
        },
        "totals": totals,
    }


def _list_run_ids() -> List[str]:
    if not LOG_ROOT.is_dir():
        return []
    run_dirs = [path for path in LOG_ROOT.iterdir() if path.is_dir()]
    return [path.name for path in sorted(run_dirs, key=_run_updated_at, reverse=True)]


@app.get("/")
def index() -> FileResponse:
    return FileResponse(str(STATIC_ROOT / "index.html"))


@app.get("/details")
def details_index() -> FileResponse:
    return FileResponse(str(STATIC_ROOT / "details.html"))


@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"status": "ok", "log_root": str(LOG_ROOT), "phase_count": len(PHASE_CONFIG)}


@app.get("/api/runs")
def runs() -> List[Dict[str, Any]]:
    output = []
    for run_id in _list_run_ids():
        try:
            payload = _run_payload(LOG_ROOT / run_id, event_limit=1)
        except OSError:
            continue
        run = payload["run"]
        output.append({
            "id": run["id"],
            "status": run["status"],
            "latest_phase": run["latest_phase"],
            "provider": run["provider"],
            "model": run["model"],
            "updated_at": run["updated_at"],
        })
    return output


@app.get("/api/runs/{run_id}")
def run_detail(run_id: str, event_limit: int = Query(240, ge=10, le=1000)) -> Dict[str, Any]:
    return _run_payload(_run_dir(run_id), event_limit=event_limit)


@app.get("/api/runs/{run_id}/events")
async def run_events_stream(
    run_id: str,
    request: Request,
    after_id: int = Query(0, ge=0),
) -> StreamingResponse:
    """Stream appended run events without reloading the dashboard snapshot."""
    run_dir = _run_dir(run_id)
    last_event_id = request.headers.get("last-event-id")
    if last_event_id and last_event_id.isdigit():
        after_id = max(after_id, int(last_event_id))

    async def updates():
        cursor = after_id
        log_path = run_dir / "calls.jsonl"
        observed_size = -1
        last_heartbeat = time.monotonic()
        while not await request.is_disconnected():
            try:
                current_size = log_path.stat().st_size if log_path.is_file() else 0
                appended = []
                if current_size != observed_size:
                    observed_size = current_size
                    appended = [event for event in _read_events(run_dir) if int(event.get("id") or 0) > cursor]
            except OSError:
                appended = []
            for event in appended:
                cursor = int(event["id"])
                payload = json.dumps(event, ensure_ascii=False, separators=(",", ":"))
                yield f"id: {cursor}\nevent: update\ndata: {payload}\n\n"
            now = time.monotonic()
            if now - last_heartbeat >= 15:
                yield ": keep-alive\n\n"
                last_heartbeat = now
            await asyncio.sleep(0.6)

    return StreamingResponse(
        updates(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/runs/{run_id}/invoke")
def invoke_service(run_id: str, body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
    """Proxy one explicit local smoke-test request to the deployed API."""
    run_dir = _run_dir(run_id)
    text = str(body.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="Enter test text")
    target = _validate_test_target(body.get("target_url"), body.get("endpoint"))

    # The generated service contract uses file paths for raw_input fields.
    # Stage interactive text under the deployed repository's mounted
    # .autodeploy directory, then send the corresponding container path.
    run_payload = _run_payload(run_dir, event_limit=1)
    repo_root_value = run_payload.get("service", {}).get("repo_root")
    if not repo_root_value:
        raise HTTPException(status_code=409, detail="This run has no writable deployment repository")
    repo_root = Path(str(repo_root_value)).resolve()
    if not repo_root.is_dir():
        raise HTTPException(status_code=409, detail="The deployment repository directory is unavailable")
    token = uuid.uuid4().hex
    host_input = repo_root / ".autodeploy" / "dashboard_inputs" / f"{token}.txt"
    try:
        host_input.parent.mkdir(parents=True, exist_ok=True)
        host_input.write_text(text, encoding="utf-8")
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"Unable to stage test input: {error}") from error
    try:
        relative_input = host_input.relative_to(repo_root)
    except ValueError as error:
        raise HTTPException(status_code=500, detail="Test input path is outside the deployment repository") from error
    container_input = _docker_work_dir() / relative_input
    request_payload = {"inputs": {"text": str(container_input)}}
    request = UrlRequest(
        target,
        data=json.dumps(request_payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    started = time.perf_counter()
    try:
        with urlopen(request, timeout=45) as response:
            raw = response.read().decode("utf-8", errors="replace")
            status_code = response.status
    except HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        status_code = error.code
    except (URLError, TimeoutError, OSError) as error:
        return {
            "ok": False,
            "status_code": None,
            "duration_ms": round((time.perf_counter() - started) * 1000),
            "request_url": target,
            "response": {"error": str(error.reason if isinstance(error, URLError) else error)},
        }
    try:
        parsed_response: Any = json.loads(raw)
    except json.JSONDecodeError:
        parsed_response = raw
    inference_status = _inference_status(parsed_response)
    return {
        "ok": 200 <= status_code < 300,
        "status_code": status_code,
        "duration_ms": round((time.perf_counter() - started) * 1000),
        "request_url": target,
        "response": parsed_response,
        "inference_status": inference_status,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("dashboard.app:app", host="127.0.0.1", port=8787, reload=False)
