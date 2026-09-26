# MADE Dashboard

Local read-only monitoring console for MADE deployment runs.

From the repository root:

```bash
PYTHONPATH=MADE_code .venv/bin/python -m dashboard.app
```

Open <http://127.0.0.1:8787>.

The dashboard reads `MADE_code/logs/<run_id>/calls.jsonl` and the optional
`variable_store_after_parallel.json` checkpoint. Set
`MADE_DASHBOARD_LOG_ROOT` when logs are stored elsewhere.

It intentionally exposes summaries, state values, phase outputs, coordination
telemetry, and service metadata; raw prompts and credentials are never sent to
the browser.
