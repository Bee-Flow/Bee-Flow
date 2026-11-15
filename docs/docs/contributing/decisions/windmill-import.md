---
title: "0029: The Windmill importer converts into inactive drafts, never imports a secret, and gates activation"
description: Why flows from Windmill are converted deterministically on the server into the existing automation envelope, why no secret or token is kept, and what an imported draft needs before it may go live.
---

# 0029: The Windmill importer converts into inactive drafts, never imports a secret, and gates activation

**Status:** accepted, in effect. **Supersedes:** no earlier record. **Code:**
`server/automation/importers/windmill/` (the converter: `toIntermediate`, `toBeeFlow`, `scrub.mts`),
`server/usecases/automation/importEnvelope.mts` (the one import pipeline, shared with the Bee Flow
JSON import), `server/usecases/automation/windmillImport.mts` (preview, commit, the report),
`server/usecases/automation/windmillRemote.mts` (a standalone Windmill read once with a token),
`server/usecases/automation/windmillConversionBrief.mts` (the "Complete with AI" briefing),
`server/automation/importGate.mts` (the activation gate and the dry-run mark),
`server/routes/automation/windmillImport.mts` (the routes, each behind `automation_import`).
**Enforced by:** `server/automation/importers/windmill/golden.test.js` and `security.test.js` (every
fixture converts to its golden file and passes the import pipeline; no secret survives),
`server/usecases/automation/windmillImport.pg.test.js` (every fixture lands on PGlite as an inactive
draft with its report, in one transaction; the gate holds until the checklist and a dry run of the
current version are done), `server/routes/automation/windmillImport.test.js` (the licence gate, the
upload guard, the token only in the Authorization header and never in an answer or error),
`server/routes/automation/activate.importGate.test.js` (activation refuses with
`import.windmill.placeholders_left` and `import.windmill.dry_run_required`).

## Context

Organisations that automated with Windmill (standalone, or inside Nextcloud as the Flow app) want to
move those flows to Bee Flow without rebuilding them by hand. A Windmill export can hold code in
several languages, references to stored credentials and triggers that keep firing in Windmill.
Bringing that over carelessly would copy secrets, run unknown code, or run every event twice.

## Decision

- **Convert, do not interpret.** The converter is pure and deterministic: it reads the export, maps
  what it knows to Bee Flow steps and triggers, and leaves a placeholder step plus a checklist item
  for the rest. It produces the existing `beeflow.automation` envelope, so the same pipeline as the
  JSON import applies (allow-list, datatable re-linking from the importer's own scopes, fresh step
  ids, validation). No LLM is involved in the import itself.
- **Always an inactive draft.** The automation row and its report row are written in one
  transaction; the draft is owned by the importer in their organisation. Nothing is switched on.
- **No secret, no token.** Resource and variable values are never read; a `$res:` or `$var:`
  reference becomes a connection to pick. Every source kept for the builder goes through the
  scrubber first. The token for a standalone Windmill lives in that one request body: it is sent in
  the Authorization header through the guarded fetch (https, public addresses, no redirects, a
  time-out and a byte cap), and never stored, logged or returned. Errors are fixed sentences, never
  the upstream body.
- **Code is never run at import.** Scripts are parsed, not executed. A plain script may become a
  code step that runs later in the isolated sandbox like any other; other languages become checklist
  items.
- **Finishing is a visible builder session.** "Complete with AI" opens the existing builder on the
  draft with a briefing the person sends themselves, through the builder's usual gates and the
  organisation's own model. There is no headless builder run.
- **Activation is gated.** An imported draft goes live only when every checklist item is resolved or
  acknowledged by a person, and a dry run of the current version ended without errors (a later edit
  asks for a new one). The gate reads the import row; once the draft has gone live it is done. The
  gate does not depend on the licence.
- **Enterprise for now.** The routes need `automation_import`; enterprise keys carry it through the
  tier (`license/tiers.js`), no change in the licence server is needed.

## Consequences

- An imported automation acts as its owner, not as the event's user or a Windmill administrator; the
  report says so per flow.
- The report names the outbound hosts of converted steps, so an administrator can check them
  against the rule for outbound personal data.
- Running a flow in both systems is prevented by the person, not by Bee Flow: the report and the
  dialog say to switch the Windmill trigger off.
