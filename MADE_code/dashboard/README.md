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

## Interface design

The dashboard and four detail views share the light workspace theme in
`static/workspace.css`. The original log fields, API contract, live event feed,
and test submission flow are retained. Select a pipeline stage to open its
shared-state detail; narrow screens also provide a run selector.

See `DESIGN.md` for the layout, semantic tokens, component rules, and responsive
breakpoints. Open `design-showcase.html` directly for an offline visual preview
with explicitly labeled sample data.

A completed historical run describes the log result. Check the separately
reported container state to determine whether its deployed service is available
now.
