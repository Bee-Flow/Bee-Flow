---
title: "0011: Tests live next to the source and run one file per process"
description: Why x.test.js sits beside x.js, why the server runner starts a process per file with its own timeout, and why --test-force-exit is never used.
---

# 0011: Tests live next to the source and run one file per process

**Status:** accepted, in effect. **Code:** `server/scripts/run-tests.mjs`,
`server/scripts/test-exclusions.json`.

## Context

A central `tests/` tree goes stale as modules move, and a single long-running test process
hides which file keeps the event loop open. `--test-force-exit` ended the process as soon as
the runner thought it was done and silently dropped unreported results.

## Decision

Tests live next to the source (`x.js` beside `x.test.js`), in every package. The server's
runner runs every colocated test file in its own process with its own timeout, minus the
exclusions documented in `test-exclusions.json` (each with a bucket and a reason; the list
may only shrink). `--test-force-exit` is not used; a file that keeps the event loop open
after its tests is reported by name as hung.

## Consequences

- Moving a module moves its tests.
- A hang is attributed to a file, never to the suite.
- A test that needs infrastructure CI does not provide is listed, with the reason, instead
  of being deleted or skipped in place.
