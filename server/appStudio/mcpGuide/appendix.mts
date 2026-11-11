/**
 * The MCP-only sections of studio_get_guide, in order.
 *
 * mcpBuilder.runGetGuide returns the in-product builder prompt (buildSystemPrompt({ toolset:
 * 'full' })) followed by these sections. They describe tools only the MCP surface has
 * (app_run_action, app_save_test, app_run_tests, ...), so the in-product prompt stays
 * byte-identical and its prompt budget never pays for them. A later package appends its own
 * section here (one string per section, starting with a "## " heading).
 */

const TESTING_ACTIONS = `## Testing actions (MCP)

app_run_action runs ONE action on the server as the app owner (owner only) and reports every step: { ok, dryRun, free, mocked, steps: [{ path, kind, status, result?, error?, ms, mocked?, iteration? }], vars, notes, definitionVersion }.
- It always reads the latest SAVED draft (fresh per call). The Studio editor autosaves, so pass expectVersion (the version app_get_action / app_set_action returned) to refuse a draft that changed in between.
- dryRun (default true) writes and sends nothing: record writes come back as { wouldWrite: { kind, tableId, values?, recordId? } }, send_email as { wouldSend: { to, subject } } (never a body), file/automation/approval steps as "would run". AI and read steps (ai_generate, ai_extract, kb_query, dataset_query) DO run, without their writeTo, unless mocked.
- Data bindings resolve on the server like a click: record, records and aggregate read the table as the owner (row access applies). A records binding without limit reads 50 rows (what a screen gets); a loop source reads at most 200 (the loop cap). A required filter without a value reads no rows. Formula-valued groupBy / aggregates / sort / limit are resolved first; pick and a record's path apply after the read. dataset and connector bindings are not read here.
- Step paths: steps[i] (top of a sequence), action[0] (a bare action), .then[i], .else[i], .cases[k].steps[i], .default[i], and a loop body .steps[i] (one path for every iteration; the report carries iteration).

Mocks: mock: { "<step path>": <answer> } gives an AI or read step a fixed MODEL answer. The step's own post-processing still runs on it, so a schema or prompt change shows up:
- ai_generate (text): "a string" or { "text": "…" } → { text, citations: [] } (markdownToHtml applies).
- ai_generate (output "structured"): { "<field>": value, … } → coerced to the step's schema (unknown keys dropped, missing ones null).
- ai_extract: { "rows": [ { … } ] } (or a list, or one row object) → { rows, count, written: 0, incomplete, … }, rows coerced to the schema.
- kb_query: [ results ] or { "results": [ … ] } → { results, count }. dataset_query: any value, as is.
- { "$error": "text", "$code"?: "…" } makes that step fail (and stop the run, as a real failure would).
A mocked step never writes, never reads files, a knowledge base or a model, and costs nothing.

Rate limit: a live run (dryRun false) takes one of the per-minute runs up front. A dry run takes one only when a step that is NOT mocked reaches the executor; a dry run whose AI steps are all mocked (or that reaches none) is free (free: true). Every call still takes a generous hygiene window (it reads the database), and a run has a read cap and a time budget; their errors name the variable.

Saved tests make a check repeatable:
- app_save_test { actionId, name, scope?, mock?, expect: [{ path, op, value }] } saves (or replaces, by actionId + name) a test next to the app, never in its definition. remove: true deletes it. Editors may save; only the owner runs.
- app_run_tests { actionIds?, names? } dry-runs every matching test against the latest draft (one definitionVersion for all) and reports pass | fail | error | not_run per test with the failing expectations ({ path, op, expected, actual }), the steps of a test that did not pass, and wasStatus (the previous result). A test whose mock or expectation names a step that no longer exists reports error with a fix hint.
- Expectation paths: ok, stopped, vars.<name>…, result… (the last server step's result), or a step path followed by .status (ok | error | skipped | refused | not_run), .result…, .error, .code, .prompt (an ai_generate step's filled-in prompt), .count (how often it ran), .mocked. Example: "steps[0].result.rows[0].customer", "steps[2].status".
- ops: is, isNot, eq, neq, contains, notContains, startsWith, endsWith, gt, gte, lt, lte, isEmpty, isNotEmpty (no value).
- A test that has no expectation on ok or stopped also fails when the run stops on an error.
- Mock every AI step in a saved test: it is then fast, free and gives the same answer every time, so a failure means the action changed.

Example: an ai_extract at steps[0] with resultVar "ex", then set_variable "who" = vars.ex.rows[0].customer:
app_save_test { "actionId": "act_intake", "name": "customer is read", "mock": { "steps[0]": { "rows": [ { "customer": "ACME" } ] } }, "expect": [ { "path": "vars.who", "op": "is", "value": "ACME" } ] }
Rename the schema field and app_run_tests reports fail with actual null.`;

const BACKGROUND_ACTIONS = `## Background actions (MCP)

A sequence with background: true runs as a server job when it is clicked: the click gets a job id at once, the page shows the progress (the current step, "Item i of n" in a loop, or the text of progressVar) and the final result, and closing the page does not stop it. A server restart ends a running job as "interrupted" (no resume).
- Allowed in a background sequence: server steps (code and http_request included), set_variable, condition, switch, loop, while, try, parallel, break, continue, return, raise_error, wait, await_approval, call_action, toast and refresh (shown when the job ends) and confirm only as the first step(s) (asked before the job starts). navigate, open_url, open_modal, close_modal, reset_form, download_file, ai_browse and the page steps (back, focus, scroll_to, copy_to_clipboard, set_form_field, set_ui) are refused by the validator (action.background_step_unsupported): put them in a second action on the same control.
- lockKey: a binding evaluated at the click; while a job with the same key runs in this app, another start is refused ("This is already running for the same item"). Namespace it: {kind:"formula", expr:"'order:' + item.id"}. A key that resolves empty locks nothing.
- progressVar: "status" shows vars.status (written by set_variable steps) as the progress text.
- A called action (call_action) runs inline in its caller; its own background/lockKey are ignored (warning action.background_in_called_action).
- Formulas in a job see form, vars, item, index, value, params, currentUser, now, today; screen, forms and actions are empty there, as in any server step.
- app_run_action runs a background action inline within its time budget and reports background: { lockKey, progressVar }. A live run (dryRun false) with a lockKey takes the lock like a click and is refused while a job holds it; a dry run takes no lock.
- Every AI call has a time-out (STUDIO_AI_CALL_TIMEOUT_MS, default 120 s) and one retry; then the step fails with "The AI gave no answer within N s" (code ai_timeout), which a step onError can handle.`;

const BULK_WRITES = `## Changing many rows, idempotent writes

- update_record / delete_record with filter: [{ field, op, value }] (instead of recordId) change every row the role may write that matches, oldest first, up to limit (default and max 500). The result is { bulk: true, matched, updated | deleted, changes, remaining, ids }; remaining > 0 means more rows match: run the step again to continue. Zero matches is a success with zeros. A clause whose value resolves to nothing (an empty form field) changes NOTHING and adds a note; it never widens the filter. isNull / isNotNull take no value. A filter (and replaceWhere) may hold { any: [clauses] } OR groups: an empty member drops out of its group, a group left empty changes nothing. Example: { kind: "delete_record", tableId: "tbl_tasks", filter: [{ field: "status", op: "eq", value: "done" }] }.
- Inside a transaction a filter child is one statement (it also sees rows created earlier in the same transaction); its result is { changed }.
- writeTo.upsertKey: ["po_number", "line"] (1 to 5 columns the step writes): a row with the same key values is UPDATED instead of added, so running the same ai_extract twice does not double the table. A row with an empty key value is inserted. Prefer it over the older single-column upsertOn, which also matches on the scalar constants.
- writeTo.replaceWhere: [clauses] deletes the matching rows first, then writes (refused, with nothing changed, when it matches more than 500 rows or a value is empty). Without upsertKey the delete and the inserts are one transaction; with upsertKey they are not (delete first, then row by row).
- In a dry run (app_run_action) a filter-mode write reports wouldWrite { kind, tableId, matched, wouldAffect, limit } (or blocked: <field>) and writes nothing; replaceWhere is not applied.`;

const RUN_INSIGHT = `## Run insight (MCP)

Every action run is logged: a click or a public page (the server steps of one click form one run), app_run_action (origin mcp), app_run_tests (origin test, one run per test), a background job and a mailbox hook. A sequence of only client steps (toast, navigate, ...) is not logged. Runs are kept for STUDIO_APP_RUN_RETENTION_DAYS (default 30; 0 keeps them).
- app_list_runs { actionId?, status?, origin?, user?: me|others|visitors|system, since?, limit?, cursor? } lists runs newest first: who (actor kind, isYou and a per-app ref, never a name), when, durationMs, status (success | error | running | interrupted | cancelled | refused), stepCount, failedSteps, the error and the step it came from (errorStep), AI calls, tokens and the estimated cost per currency.
- app_get_run { runId } gives the steps in order: path (the app_run_action paths), kind, status, durationMs, error and code, attempts, handled (an onError handler ran), mocked, and per AI step { calls, model, tier, promptTokens, completionTokens, cost, currency }.
- app_run_action and app_run_tests return the runId of their run.
- Debugging a failure: app_list_runs { status: "error", actionId } → app_get_run { runId } shows the failing step and its error; reproduce it with app_run_action (dryRun) and keep it fixed with app_save_test.
- A browser run that never reported its end (the page closed) closes itself after a minute without activity; its status follows its steps (endedBy "idle").
- No results, inputs, variables or prompts are kept: only what ran, how long it took and how it ended.`;

const KB_QUERY_LOG = `## KB query log steps (Enterprise)

Two server steps turn the query log of a knowledge base (what people asked it, what it found and answered) into an app, for example the work queue of a quality review. They need the licence feature kb_query_log, and BOTH the app owner and the person pressing the button must manage the knowledge base (the "manage knowledge" permission, or own it). They are refused on public apps and in mailbox-hook actions (nobody is pressing a button), and the review never writes in a dry run.
- kb_log_query: { "kind": "kb_log_query", "kbId": {"kind":"static","value":"<knowledge base id>"}, "filters": { "status": {"kind":"static","value":"to_review"}, "outcome": {"kind":"static","value":"no_results"} }, "limit": 50, "resultVar": "queue" }. filters keys: from, to (ISO dates), userId, channel, outcome (answered | no_results | error), status (to_review | reviewed | needs_addition); an empty value means no filter. limit defaults to 50, max 200. resultDetail defaults to "summary" (no question, passages, answer or note, only metadata); set "full" to read the logged text. Result: { rows, total, count }; a row has id, createdAt, userId, userName, channel, query, chunks [{ title, sourceUri, score, page, text }], chunkCount, topScore, answer, citations, outcome, reviewStatus, reviewNote, reviewedBy, reviewedAt.
- kb_log_review: { "kind": "kb_log_review", "kbId": {"kind":"static","value":"<id>"}, "entryId": {"kind":"formula","expr":"item.id"}, "status": {"kind":"static","value":"reviewed"}, "note": {"kind":"formula","expr":"form.note"} }. status: to_review | reviewed | needs_addition. The reviewer recorded is the person pressing the button. In a dry run (app_run_action) the review is skipped; kb_log_query runs.`;

const NEWER_CATALOGUE = `## Newer parts of the catalogue, triggers and unattended runs (MCP)

The guide above renders the base catalogue and ends its extension index. Components, props, style knobs, steps, data options and theme keys that are listed only in that index exist and are legal, but their rules are NOT in the guide: read the entry first with app_inspect_catalog { extensions: ["<name>", …] } (or { family: "<family>" }) and write from it. A definition that uses none of them is stored exactly as before; one that does is stored with schemaVersion 3.
- Look and shell: app_set_theme takes tokens, dark, fonts, radiusPx and customCss; app_set_shell sets the navigation style, brand, header, items and footerText; app_update_screen and app_update_section take a theme of their own; app_list_assets lists the uploaded files (asset:<id>), which you cannot upload from here. design.customCss is cleaned when saved: every at-rule but @media, @supports and @container, position: fixed and any url() that is not data:image/… or asset:<id> are removed and named in the repair hints.
- Logic: app_update_step changes ONE step by its path without resending the action; app_set_variables takes scope "screen", persist and derived; steps can carry guard (a server-side formula, decide with currentUser only). Page-only steps (back, focus, scroll_to, copy_to_clipboard, set_form_field, set_ui) are skipped by app_run_action and refused in server runs.
- Data: field access (column rights), lookup, rollup, many relations, onDelete, validation, indexes, row rules per operation, expand, search, orderBy and dataset parameters are in the data family of the index. A role without read access to a field gets a refusal, not an empty value, when it names the field in a filter, sort or aggregate.
- Triggers start an action on the server by themselves and only run once the app is PUBLISHED: app_set_trigger (schedule, webhook), app_set_record_trigger and app_remove_trigger. The run is the app owner, so its action may only hold steps that run unattended; the validator names a step in the way. You cannot read or set a webhook's address or secret: the owner sees them in the Triggers panel after publishing. Test the action with app_run_action { scope: { trigger: { kind: "record", record: { event, row, before, changed } } } }; a test never starts a trigger. A record trigger fires only on a one-row change a person makes in the app (and on such a step of another trigger run), never on rows you write with app_seed_records or app_update_records.
- Waiting: a wait or await_approval needs runOn "server" or background: true on the sequence. app_run_action skips a wait and goes on past await_approval as approved unless you mock it, e.g. mock { "steps[1]": "rejected" }.
- Not for you, ask the owner: REST connectors and their credentials, allowedLinkHosts, serverScope, watchers and a webhook's secret.`;

export const MCP_GUIDE_SECTIONS: readonly string[] = Object.freeze([TESTING_ACTIONS, BACKGROUND_ACTIONS, BULK_WRITES, RUN_INSIGHT, KB_QUERY_LOG, NEWER_CATALOGUE]);
