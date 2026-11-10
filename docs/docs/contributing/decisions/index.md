---
title: Architecture decision records
description: The decisions that shape how Bee Flow is built, each with the problem it answers, what was chosen, and what that costs. Written down so a contributor can tell a rule from a habit.
---

# Architecture decision records

A decision record states one choice: the situation that forced it, the choice itself,
and its consequences, the unwelcome ones included. The records here are retrospective:
the decisions were in effect before they were written down, and each one points at the
code or the check that enforces it. A record is never edited to say something else; a
decision that changes gets a new record that supersedes the old one.

| Record | Decision |
|---|---|
| [0001](./server-javascript-jsdoc.md) | The server stays JavaScript; types are JSDoc, checked per file at rising levels |
| [0002](./ratchets.md) | Quality is kept by ratchets: budgets that may only go down |
| [0003](./provider-adapters.md) | One adapter per LLM provider, one adapter for every self-hosted runtime, pricing on the stored provider type |
| [0004](./context-management.md) | Two context-management mechanisms: lossless by default, lossy compaction opt-in |
| [0005](./generated-copies.md) | Generated copies, never hand copies |
| [0006](./desktop-loads-the-spa.md) | The desktop client loads the SPA from the server; IPC trust comes from the sender's URL |
| [0007](./personal-data-leaves-by-email-only.md) | Personal data leaves Bee Flow by e-mail only; outbound payloads are built from allow-lists |
| [0008](./licence-verification.md) | Licence keys are verified here and issued elsewhere |
| [0009](./platform-operator.md) | One built-in platform-operator account, by fixed id, in one module |
| [0010](./release-notes.md) | Release notes live on GitHub Releases; the repository keeps no changelog file |
| [0011](./tests-next-to-the-source.md) | Tests live next to the source and run one file per process |
| [0012](./route-contract-and-tenant-matrix.md) | Every route declares its gate; tenant isolation is tested by matrix |
| [0013](./run-profile.md) | One run profile, decided when a run starts, says what the run may do |
| [0014](./assistant-sees-what-the-canvas-shows.md) | The assistant sees what the canvas shows: every step type, building block and connected tool, in the canvas's words, on every model band |
| [0015](./per-person-adoption-view.md) | The per-person adoption view is pseudonymous by default, a name reveal is audited and fails closed, and adoption adds no navigation tracking |
| [0016](./kb-query-log.md) | The knowledge-base search log is opt-in per base, readable by its managers only, sealed under an organisation key, and opened to compliance only behind an open data-subject request |
| [0017](./connector-no-default-server.md) | The Nextcloud connector has no Bee Flow server until an administrator chooses one; nothing is sent before that choice |
| [0018](./teams-meeting-import-permissions.md) | Teams meetings are imported per organiser with delegated permissions by default; application permissions are opt-in per organisation, take the tenant only from verified sources and re-check coverage at use |
| [0019](./org-admin-is-not-platform-admin.md) | An organisation admin is not a platform admin in any deployment mode, and administers only the organisations where one strict check holds |
