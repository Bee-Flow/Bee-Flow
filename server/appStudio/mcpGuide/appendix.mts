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
- Allowed in a background sequence: server steps, set_variable, condition, switch, loop, call_action, toast and refresh (shown when the job ends) and confirm only as the first step(s) (asked before the job starts). navigate, open_url, open_modal, close_modal, reset_form, download_file and ai_browse are refused by the validator (action.background_step_unsupported): put them in a second action on the same control.
- lockKey: a binding evaluated at the click; while a job with the same key runs in this app, another start is refused ("This is already running for the same item"). Namespace it: {kind:"formula", expr:"'order:' + item.id"}. A key that resolves empty locks nothing.
- progressVar: "status" shows vars.status (written by set_variable steps) as the progress text.
- A called action (call_action) runs inline in its caller; its own background/lockKey are ignored (warning action.background_in_called_action).
- Formulas in a job see form, vars, item, index, value, params, currentUser, now, today; screen, forms and actions are empty there, as in any server step.
- app_run_action runs a background action inline within its time budget and reports background: { lockKey, progressVar }. A live run (dryRun false) with a lockKey takes the lock like a click and is refused while a job holds it; a dry run takes no lock.
- Every AI call has a time-out (STUDIO_AI_CALL_TIMEOUT_MS, default 120 s) and one retry; then the step fails with "The AI gave no answer within N s" (code ai_timeout), which a step onError can handle.`;

const BULK_WRITES = `## Changing many rows, idempotent writes

- update_record / delete_record with filter: [{ field, op, value }] (instead of recordId) change every row the role may write that matches, oldest first, up to limit (default and max 500). The result is { bulk: true, matched, updated | deleted, changes, remaining, ids }; remaining > 0 means more rows match: run the step again to continue. Zero matches is a success with zeros. A clause whose value resolves to nothing (an empty form field) changes NOTHING and adds a note; it never widens the filter. isNull / isNotNull take no value. Example: { kind: "delete_record", tableId: "tbl_tasks", filter: [{ field: "status", op: "eq", value: "done" }] }.
- Inside a transaction a filter child is one statement (it also sees rows created earlier in the same transaction); its result is { changed }.
- writeTo.upsertKey: ["po_number", "line"] (1 to 5 columns the step writes): a row with the same key values is UPDATED instead of added, so running the same ai_extract twice does not double the table. A row with an empty key value is inserted. Prefer it over the older single-column upsertOn, which also matches on the scalar constants.
- writeTo.replaceWhere: [clauses] deletes the matching rows first, then writes (refused, with nothing changed, when it matches more than 500 rows or a value is empty). Without upsertKey the delete and the inserts are one transaction; with upsertKey they are not (delete first, then row by row).
- In a dry run (app_run_action) a filter-mode write reports wouldWrite { kind, tableId, matched, wouldAffect, limit } (or blocked: <field>) and writes nothing; replaceWhere is not applied.`;

export const MCP_GUIDE_SECTIONS: readonly string[] = Object.freeze([TESTING_ACTIONS, BACKGROUND_ACTIONS, BULK_WRITES]);
