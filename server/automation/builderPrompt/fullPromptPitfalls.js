// @typecheck strict
'use strict';
/**
 * The last working rules of the FULL builder system prompt: error branches,
 * single-step lookups, iterating over a list and the pitfalls.
 * ../builderPrompt.js buildFullSystemPrompt splices CONDITION_RULES_HINT
 * between FULL_PROMPT_PITFALLS and FULL_PROMPT_PITFALLS_TAIL. The text is part
 * of the prompt cache's prefix: a changed byte rebuilds every cached prompt.
 */

// Error branches, single-step lookups, iteration, and the pitfalls list up
// to its condition-rules item.
const FULL_PROMPT_PITFALLS = `## Error handling (on-error branches)

By default a failing step fails the whole run. When the user wants a
fallback ("if the upload fails, notify me instead", "log errors to a sheet
and keep going"), wire an ERROR BRANCH:

  - New fallback step: call builder_add_action / builder_add_ai_step /
    builder_add_notification with \`afterStepId\` = the failure-prone step and
    \`branch:"error"\` — the edge is labelled \`on_error\`.
  - Existing step as fallback: \`builder_wire_error_branch({fromStepId, toStepId})\`.

Semantics:
  - Per-step retries run FIRST — the error branch only fires after the final
    attempt fails. Configure retries on the step itself when transient
    failures should be retried before falling back.
  - Inside the branch, bind the failure as
    \`steps.<failedStepId>.error.message\` / \`.errorClass\` / \`.stepId\`
    (the failed step's \`output\` is null — never bind its output fields on
    the error path).
  - A run whose failures are all handled this way still reports SUCCESS,
    annotated "N step error(s) handled by error branch" in the run history.
  - Only failure-capable steps can have an error branch: integration_action,
    ai_step, data_extraction, code, http_request, generate_document, fill_document, presentation, parse_json (legacy),
    call_layer, loop, parallel, notification, wait. NEVER from trigger / condition / switch / approval /
    form_page / stop_error / return_to_app (approval and form_page pause, condition and switch
    route, and the last two END the run — an error branch out of a step that ends the run is a
    promise nothing can keep).
  - Error branches work inside flowlets too; an error escaping a flowlet can be
    handled by an on_error edge on the call_layer step in the parent flow.

## Single-step "look up X and send Y" automations

When the user describes a flow that's basically "fetch this, then deliver
that" (e.g. "look up the weather and email me the summary"), you have TWO
valid shapes — pick whichever is simpler:

  Shape A — explicit chain: integration_action (e.g. agent_search) → ai_step (summarise) → integration_action (gmail_compose)
  Shape B — single ai_step with tools: builder_add_ai_step({ prompt:"Look up the weather in Amsterdam and email a friendly summary to user@example.com.", allowTools:true, tools:["agent_search","gmail_compose"], modelTier:"auto" })

Shape B is appropriate when the user says "do it without an extra step",
"do it in one go", or the lookup is conditional ("only search if today's
appointment is outside"). The runner enforces the user's permissions on
the tools allowlist — never invent tool names that aren't in the catalog.

## Iterating over a list (forEach vs loop)

When something must happen for EACH item of an upstream array, pick the lighter shape:

- **ONE step per item** → set \`forEach\` ON that step (no loop node). Works on
  \`integration_action\`, \`ai_step\`, \`code\`, \`notification\`, \`set\`, \`http_request\`, \`datatable\`
  (one save_row / update_rows per item — bind \`loop.<itemVar>.<field>\` in values and where) and
  \`knowledge_write\` (one article per item — give each a distinct \`sourceUri\`, or every item
  overwrites the same document):
  \`builder_add_action({ tool:"gmail_read", forEach:{ overRef:"steps.<search>.output.messages", itemVar:"email" }, inputs:{ messageId:{kind:"ref",path:"loop.email.id"} } })\`.
  Inside that step, reference the current item as \`loop.<itemVar>\`. The step's result
  becomes an array at \`steps.<id>.output.results\`.
- **MULTIPLE steps per item** (read THEN summarise THEN label) → still \`forEach\`, CHAINED.
  Each entry of \`steps.<id>.output.results\` is \`{index, item, output, status}\`, so pointing the
  next step's \`forEach\` at that array keeps the per-item link: \`loop.<v>.item\` is the original
  and \`loop.<v>.output\` is that item's result from the step before. A failed item has
  \`status:"error"\` and no \`output\`, so filter first:
  \`builder_add_array_op({op:"filter", arrayRef:"steps.<prev>.output.results", expr:"equals(item.status, \\"success\\")"})\`.
- **A \`loop\` step** is for the rare shape where two steps need the SAME source item without one
  consuming the other's results, or where a body step branches. Note the failure semantics differ:
  a \`loop\` aborts entirely on the first failing item; \`forEach\` collects the error, continues,
  and fails only if every item failed. A loop's body also records nothing in run history.

Default to per-step \`forEach\` — do NOT wrap one step in a loop, and do not reach for a loop
merely because the work has several stages per item.
**A bulk tool beats a forEach of single calls**: every forEach item is its own API request, a
bulk tool does the whole list in one or two. Read many emails with ONE \`gmail_read_many\`
(\`messageIds:{kind:"ref",path:"steps.<search>.output.results[*].id"}\`; \`outlook_read_many\` for
Outlook) instead of \`gmail_read\` per email; it reads at most 100, so keep the search's
\`maxResults\` at 100 or less. Every \`outlook_*\` tool takes an optional \`mailbox\`: omit it (or "me")
for the user's own mailbox, or give a shared mailbox's address to search, read, reply and send there
(a send then goes out AS that mailbox); bind it to \`trigger.output.mailbox\` after an Outlook mail trigger. Label, mark read or archive them with ONE \`gmail_bulk_modify\` instead
of \`gmail_modify_labels\` / \`gmail_mark_read\` / \`gmail_archive\` per email, bound to the emails that
were actually read: \`messageIds:{kind:"ref",path:"steps.<readMany>.output.messages[*].id"}\`. Keep
\`forEach\` for work that really is one call per item, such as \`gmail_read_attachment\` over
\`steps.<readMany>.output.messages[*].attachments\`.
A table of attachments WITH their email's fields (one row per attachment, its sender and subject on
every row): \`builder_add_array_op({op:"flatten", arrayRef:"steps.<readMany>.output.messages", childField:"attachments"})\`,
then \`forEach\` over \`steps.<flat>.output.items\` (the item has \`attachmentId\`, \`messageId\`, \`filename\`,
\`from\`, \`subject\`). Google Sheets append still needs \`forEach\` per row.
Catalog actions that return a list are marked \`[list]\`; if unsure what array a tool yields,
call \`builder_inspect_tool\` (its \`iterableFields\` names the arrays you can iterate over).

## Common pitfalls to avoid

- Refusing tasks because "no integration exists": every tool the user has
  rights to is in the catalog below. If the user asks for something
  obviously achievable (weather, news, generic web lookups) propose
  \`agent_search\` (when present) instead of saying it's impossible.
- Output field names you "guess": each tool in the catalog below shows
  its actual output shape. Use exactly those keys. When the catalog
  doesn't list a shape, call \`builder_inspect_tool\` BEFORE you bind —
  don't guess. After a dry-run, every step result also includes a
  \`_hint\` with the real top-level keys; use those to self-correct.
- Forgetting binding wrappers around literal values.
- Wiring a notification AFTER a loop while referencing
  \`loop.<itemVar>\` — those refs only resolve INSIDE the loop body.
  Outside the loop, refer to \`steps.<loopId>.output.results\` instead.
- Growing a condition branch: add the next step with \`afterStepId\` set to
  the condition's id — the edge is AUTO-labelled "then" on the first append
  and "else" on the second. Pass \`branch:"then"|"else"\` to override, or use
  thenStepId/elseStepId to wire EXISTING steps. For a \`switch\`, pass
  \`caseName\` (or the switch's \`nextStepIds\` map) when appending a branch
  step, or that case dead-ends.
- A condition decides ONCE for the whole run; to keep the matching items
  of a list use \`builder_add_array_op({op:"filter"})\` (or a switch with
  arrayRef) and continue on its output.items. A condition that reads
  \`list[*]\` sends every item the same way, so the steps after it still
  process all of them.
- Condition, filter and switch rules: `;

// The pitfalls after the condition-rules item.
const FULL_PROMPT_PITFALLS_TAIL = `
- Inserting INTO an existing chain: \`afterStepId\` alone adds the new step
  BESIDE the anchor's current successor (the old edge stays, so both run in
  parallel and nothing downstream can depend on the new step). Pass
  \`splice:true\` to re-point that successor edge to the new step so it runs
  in between - the way to add a step mid-chain without remove-and-re-add.
- ai_step output is JSON, not prose. When a downstream step references
  \`steps.<aiId>.output.<field>\` (e.g. \`replyText\`, \`summary\`), pass an
  \`outputSchema\` like \`{ replyText: "string" }\` to \`builder_add_ai_step\`
  AND tell the model in the prompt to "respond with JSON having those
  keys". Without a schema the model returns prose and the downstream
  binding silently resolves to undefined. (The runner now infers a
  schema from your refs as a safety net, but explicit is better — the
  model produces tighter, more on-spec output when the schema is set.)
  A step that FANS OUT over the ai_step's results reads the SAME fields as
  \`loop.<itemVar>.output.<field>\` — that shape the runner CANNOT infer, so
  the validator REFUSES an ai_step read that way while it declares no
  \`outputSchema\` (\`ai_step.output_schema_missing\`, blocks activation);
  direct \`steps.<aiId>.output.<field>\` reads only WARN
  (\`ai_step.output_schema_inferred\`). Do not wait for a dry run to catch
  it: the write step after it is only simulated, so a dry run goes green on
  an automation that extracts nothing.
- ai_step instructions are split across two fields. Put the stable
  role/persona/tone/output-style in \`systemPrompt\` (e.g. "You are a
  news researcher", "Answer only in Dutch") and the concrete per-run
  task + data references in \`prompt\`. Set \`systemPrompt\` whenever the
  step benefits from a stable role; leave it off for trivial one-off
  transforms (then the default automation-step system prompt is used).
`;

module.exports = { FULL_PROMPT_PITFALLS, FULL_PROMPT_PITFALLS_TAIL };
