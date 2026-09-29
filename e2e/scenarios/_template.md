---
# Copy this file to <id>.md — the filename (without .md) MUST equal `id`.
id: _template
title: One-line description of what this scenario verifies
# mode:
#   generated                  — Claude generates a committed Playwright spec (npm run gen -- <id>)
#   agentic                    — Claude drives the browser live at runtime; no spec needed
#   generated+agentic-fallback — generated spec; on failure the scenario is re-run
#                                agentically to distinguish spec rot from a real regression
mode: generated+agentic-fallback
tags: [smoke]
# requires: capabilities the target stack must provide; the scenario is skipped
# when E2E_CAPABILITIES does not include them. Known: llm, search, search-retrieval
requires: []
# timeout in ms for the generated test AND the per-run wall clock budget (default 90000)
timeout: 90000
# auth: admin (reuse the logged-in session) | none (fresh, logged-out context)
auth: admin
# cleanup: natural-language description of what must be removed afterwards,
# even when the scenario fails halfway. The generator emits a matching
# afterEach/finally; the agentic runner executes it before reporting.
cleanup: ""
---

## Steps

1. Describe each step in plain language. Reference `data-testid` values from
   `e2e/context/app-map.md` where you know them — the generator may only use
   testids that exist in that file.
2. ...

## Expected

- Observable outcomes, phrased as assertions ("a message containing X appears",
  "the URL is /app/studio/agents"). Prefer eventual assertions over exact
  matches for LLM output.

## Notes for generation

- Optional hints for the spec generator (selectors to prefer, timing caveats).
