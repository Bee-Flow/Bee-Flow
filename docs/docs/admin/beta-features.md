---
title: Beta features
---

# Beta features

Path: **Admin → Beta features**.

Beta features are flags for capabilities that are stable enough to ship but not ready for default-on. They're per-org — you opt in for your tenant only.

![Beta features panel](../img/screenshots/admin/beta-features/)

## Available flags

| Flag | What it enables | Status |
|------|-----------------|:------:|
| `feature_notebooks_enabled` | Notebooks: the Notebook document type in Studio → Documents (sources and an assistant that answers from them) | beta |
| `feature_voice_call_v2` | New full-duplex voice with sub-second latency | beta |
| `feature_agent_memory_v2` | Improved memory extraction with structured fields | beta |
| `feature_skills_v2` | Skill composition + dependency graphs | beta |
| `feature_kb_reranker` | Cross-encoder reranking for KB search | beta |

## How to enable

Toggle the flag in the panel and click **Save**. No restart needed — the flag is read on every request.

## Server defaults

For self-hosters, the *server-wide* default for each flag is set via env vars (see [env reference → Feature flags](../self-hosting/env.md#feature-flags)). The org panel can only enable a flag that's globally allowed — if the server has `FEATURE_NOTEBOOKS_ENABLED=false`, no org can opt in.

## Stability guarantees

- **Stable** features won't break across minor server versions.
- **Beta** features may introduce breaking changes between minor versions — read the release notes.
- **Experimental** features (not listed here, gated behind a separate `BEEFLOW_EXPERIMENTAL=true`) can change without notice.

## Reporting issues

When a beta feature misbehaves:

1. Reproduce + capture logs (Org → Audit if Enterprise+, otherwise `docker logs beeflow-server`).
2. File at [https://github.com/Bee-Flow/beeflow/issues](https://github.com/Bee-Flow/beeflow/issues) with the feature flag in the title.

## Promoting beta → stable

When a beta feature graduates, it becomes default-on. The flag stays in the panel for one minor version (so admins can opt-out if it broke their flow), then is removed.
