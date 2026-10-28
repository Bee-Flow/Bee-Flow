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
| [0001](./0001-server-javascript-jsdoc.md) | The server stays JavaScript; types are JSDoc, checked per file at rising levels |
| [0002](./0002-ratchets.md) | Quality is kept by ratchets: budgets that may only go down |
| [0003](./0003-provider-adapters.md) | One adapter per LLM provider, one adapter for every self-hosted runtime, pricing on the stored provider type |
| [0004](./0004-context-management.md) | Two context-management mechanisms: lossless by default, lossy compaction opt-in |
| [0005](./0005-generated-copies.md) | Generated copies, never hand copies |
| [0006](./0006-desktop-loads-the-spa.md) | The desktop client loads the SPA from the server; IPC trust comes from the sender's URL |
| [0007](./0007-personal-data-leaves-by-email-only.md) | Personal data leaves Bee Flow by e-mail only; outbound payloads are built from allow-lists |
| [0008](./0008-licence-verification.md) | Licence keys are verified here and issued elsewhere |
| [0009](./0009-platform-operator.md) | One built-in platform-operator account, by fixed id, in one module |
| [0010](./0010-release-notes.md) | Release notes live on GitHub Releases; the repository keeps no changelog file |
| [0011](./0011-tests-next-to-the-source.md) | Tests live next to the source and run one file per process |
