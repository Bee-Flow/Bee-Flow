# Builder tools — the rules the loops taught us

The automation builder is driven by small local models. Measured 2026-09-12/13 on one invoice
brief: such a model can ADD a step it is told to add, cannot EDIT one field of a batch it
already sent (it resends the byte-identical call), and does not obey "stop retrying".
Every rule below follows from that.

1. A rejection the server could have repaired deterministically is a server bug, not a
   model bug. Repair, and say so in `_warnings`. Reject only on real ambiguity.
2. Every rejection with a mechanical fix carries it machine-readably: `_suggestedPatch`
   (`suggestedPatch.js` ops) and, for a batch, `resendAs`. The prose error is for humans.
3. A batch keeps what was valid. `builder_add_steps` applies entries in order, keeps the
   built prefix, and a resend never builds the same entry twice (`addSteps.js`: `_tempIds`,
   `_builtThisTurn`). The repeat ladder in `../builderTools.js` does the rest:
   hint → auto-patch → stop with a user-facing message.
4. Every measured loop becomes a trace fixture in `traces/` (from the
   `[AutomationBuilder] rejected …` log line via `scripts/builder-trace-from-log.mjs`)
   and `builderTools.traces.test.js` must show it applies. Unit tests per shape do not
   predict the next shape; the corpus does not either, but it never regresses.
5. No builder change ships without `scripts/builder-live-run.sh` passing on the local
   model against `server/scripts/builder-briefs/*.json` — a rebuilt container, a real
   build, the expected chain. "The tests pass" is not the gate; the automation on the canvas is.
6. When adding a step type or tool, check the four seams that bit: fields under `inputs`
   that belong at the top level, step fields beside `spec`, prompt placeholders standing in
   for `source`, and silent coercion of an unknown enum value.
7. Which step types the builder can author is decided in ONE place, `stepTypeTable.js`. The
   batch and replace enums, `ADD_FOR_TYPE` and the prompt's canvas-only entries read it, and
   `stepTypeTable.test.js` compares it with the validator's `VALID_STEP_TYPES`. A new runtime
   step type fails that test until you say whether the builder can make it. Do not extend an
   enum, the apply map or the prompt's step list by hand.
8. Tables. `builder_create_datatable` has three modes: direct (Build directly, MCP), staged
   (a preview: nothing is created, steps point at `pending:<n>` and the proposal carries the
   table, `pendingDatatables.js`) and plan-scoped (an approved plan lists the tables a build
   may create). Only the user's Apply creates a staged table
   (`routes/ai/automationBuilder/applyPendingDatatables.js`), and a pending id never reaches
   the database: the validator flags it (`datatable.table_pending`), `persistDraft` throws and
   the runner fails closed. Binding an EXISTING table needs the user's choice in a chat work
   mode (`datatableApproval.js`, one site: `applyAddDatatable`); MCP sets no approval Set and
   is not gated. Do not add `builder_create_datatable` to `MUTATING_TOOLS`: it changes no
   graph, so it must not get a `scope` parameter or the persist-and-emit after a call.
