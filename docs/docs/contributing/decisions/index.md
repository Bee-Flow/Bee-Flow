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
| [0001](./server-javascript-jsdoc.md) | The server stays JavaScript; types are JSDoc, checked per file at rising levels (superseded by 0026) |
| [0002](./ratchets.md) | Quality is kept by ratchets: budgets that may only go down |
| [0003](./provider-adapters.md) | One adapter per LLM provider, one adapter for every self-hosted runtime, pricing on the stored provider type (superseded by 0027) |
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
| [0020](./app-definition-schema-versions.md) | App definitions have schema versions; the lowest sufficient version is written, and a corpus of stored apps gates every change |
| [0021](./author-code-only-in-the-code-step.md) | An app may run its author's code, but only in the isolated code step, over named inputs |
| [0022](./look-closed-vocabulary-scoped-css.md) | The look of an app is a closed vocabulary plus a scoped stylesheet; there is no free markup in the SPA |
| [0023](./unattended-runs-act-as-the-owner.md) | Unattended runs act as the app owner, and are armed only from a published definition |
| [0024](./trigger-chain-keeps-its-start.md) | A chain of trigger runs keeps the rules of what started it |
| [0025](./column-rights-in-the-data-layer.md) | Column rights are enforced in the data layer and proved by oracle tests |
| [0026](./server-typescript-for-new-code.md) | New server code is TypeScript (`.mts`) that Node runs as written; the existing files stay JavaScript with JSDoc types, and the architecture gates read how the two load each other |
| [0027](./provider-type-outside-the-adapters.md) | One adapter per LLM provider; code outside the adapters compares the stored provider type for model registration, price keys, the path a call takes and configuration, and a price never follows a guessed adapter |
| [0028](./webhook-header-token.md) | Webhook callers that cannot sign may use a header token; signing stays the default |
| [0029](./windmill-import.md) | The Windmill importer converts deterministically into inactive drafts, never imports a secret or keeps a token, and gates activation on a finished checklist and a dry run |
| [0030](./cowork-plan-closed-step-list.md) | A Cowork plan is an automation held to a short list of steps; its permissions and its fingerprint are derived from the plan, and only a plan that may do more needs approval again |
| [0031](./outside-text-informs-never-instructs.md) | In a Cowork plan, text written outside the workspace is marked and followed through the steps: it may fill content, and never picks a recipient, a target, a web address or a tool |
| [0032](./cowork-plan-reaches-its-owner.md) | What a Cowork plan sends without a send step reaches its owner alone: an approval asks the owner, a plan run ignores its automation's notification settings, and an automation a Solution stage manages is no plan |
| [0033](./cowork-planner-builds-with-builder-tools.md) | Cowork drafts a plan from a brief with the automation builder's own tools in a headless loop on a narrow menu; the plan check stays the gate, and nothing the planner makes is approved or run by it |
| [0034](./held-definition-across-a-pause.md) | A journey a feature started on its own copy keeps that copy across a pause: a Cowork plan that waits for its owner's decision continues on the plan as approved, and its run is closed when the journey ends |
| [0035](./plan-independence-levels.md) | How independent a Cowork plan may be is a question added at run time: a level puts approval steps in front of what it asks about in the run's copy, never changes the approved plan, and a run keeps its level across a pause |
| [0036](./plan-scripts-out-of-process.md) | A Cowork plan's script is a calculation: it runs in a child process of its own around the isolated-vm sandbox, with no network, no apps and no secrets, marked so by the run copy and never by its author |
| [0037](./cowork-organisation-policy.md) | An organisation's Cowork policy is read at every start, through one door, and an unreadable policy is the strictest: read-only, the ceiling, the apps that may run while nobody watches and the monthly budget hold for every kind of run |
| [0038](./cowork-trust-per-step-and-recipient.md) | Trust in a Cowork plan grows per step and recipient after five approvals, is offered and never assumed, a single stop takes it away, and the organisation's ceiling wins |
| [0039](./cowork-sharing.md) | A shared cowork stays its owner's: colleagues of the same organisation may see it, one may decide its questions, and every read checks current membership |
| [0040](./cowork-budgets.md) | Cowork budgets are measured from the usage ledger in euros: an item pauses itself at its own budget, an organisation refuses runs at its budget without pausing anything, and an unreadable cost does not stop a run |
| [0041](./cowork-run-receipts.md) | Every closed Cowork run gets a receipt of names and counts, chained per item by hash and signed with the installation's Ed25519 key, issued apart from closing the run so it can never stop one |
| [0044](./cowork-mail-plans.md) | A Cowork plan may start on a new mail, with the mail as outside start data; it drafts its answers and never sends them, and the one recipient a draft may take from the mail is its sender |
| [0045](./cowork-desks.md) | Coworks of different owners on one desk hand each other data, never access: the follower runs as its own owner with only the result as outside text, a chain ends after three hand-offs between owners, and a role's questions move to its stand-in after a working day |
