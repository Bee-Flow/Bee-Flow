'use strict';
/**
 * The "Reliable AI steps" section of the FULL builder system prompt (and so of
 * the MCP guide, which ships the full prompt): how to make the answer of an
 * ai_step something later steps can rely on. ../builderPrompt.js splices it
 * right after the form wizards. Examples stay generic on purpose: sorting
 * messages into categories from a list, a short summary that may only quote
 * figures from a table, a reply that must be in the Latin alphabet. The lean
 * prompt does not carry it (the small menu hides these attributes).
 *
 * Every one-line JSON example below is parsed and run through
 * sanitizeAiStepReliabilityArgs by fullPromptAiChecks.test.js, so the guide
 * cannot drift from the shapes the builder tools accept.
 */

const FULL_PROMPT_AI_CHECKS = `

## Reliable AI steps (structure, allowed values, checks)

Declare \`outputSchema\` on every ai_step whose answer a later step reads. With a schema
and no tools the answer comes back as STRUCTURED output (the provider is held to the
schema), so never ask for "JSON only" in the prompt, never add a parse step. A step that
offers tools (allowTools, an agent with useTools, skills) keeps the text route and is
parsed from its reply. Everything below is optional: leave a field out and the step
behaves exactly as before. The checks run after the answer and are NEVER sent to the model.

**temperature** (0..2, default 0.2): leave it out unless asked. Use 0 for extraction-like work
(sorting, picking, copying figures), at most about 0.7 for drafting; above 1 answers vary a lot.

**enumFrom: allowed values from run data.** The list at \`ref\` (a plain run path, no {{ }},
never secrets), read from \`value\` in each item (omit \`value\` for a list of plain text),
is SHOWN to the model as the only allowed values AND checked after the answer.
\`field\` names an outputSchema field: "category", "tags[]" (every item of a list field),
"items[].category" (a field inside list items). Case is ignored unless \`ignoreCase:false\`;
\`allowEmpty:true\` lets the field stay empty.
  {"outputSchema":{"type":"object","properties":{"category":{"type":"string"}}},"temperature":0,"enumFrom":[{"field":"category","ref":"steps.cats.output.rows","value":"name"}]}

**checks: rules for the finished answer** (at most 20, four kinds):
- \`allowedFrom {field, ref, value?}\`: the text is one of the listed values. It only checks:
  the list is not shown to the model, so use it for values the prompt already holds (ids of
  the input items) and enumFrom when the model has to choose from a list.
- \`numbersFrom {field, ref, tolerance?, ignoreUpTo?}\`: every number in the text also appears
  in the data at \`ref\`. For "a short summary that may only quote figures from a table".
  \`tolerance\` is an absolute difference (default 0), \`ignoreUpTo\` skips small whole numbers
  such as "3 items" (default 0); percentages and dates are handled by default.
- \`script {field, script, minRatio?}\`: the text is written in that writing system (latin,
  cyrillic, greek, arabic, hebrew, han, japanese, hangul, devanagari, thai); \`minRatio\`
  is the share of letters that must match (default 1).
- \`items {field, minItems?, maxItems?, sameCountAs?}\`: a list field has that many items;
  \`sameCountAs\` is a run path to another list with the same count.
  {"checks":[{"kind":"numbersFrom","field":"summary","ref":"steps.totals.output.rows","ignoreUpTo":10},{"kind":"script","field":"reply","script":"latin"}]}
  {"checks":[{"kind":"allowedFrom","field":"category","ref":"steps.cats.output.rows","value":"name"},{"kind":"items","field":"tags","minItems":1,"maxItems":5}]}

**When an answer fails.** The model gets ONE automatic repair round (it is told which field
broke which rule and what it wrote there, never the source data). If it still fails,
\`fallback\` decides. \`{"kind":"fail"}\` (the default as soon as enumFrom or checks exist) stops the
step with errorClass \`ai_check_failed\`, which a builder_wire_error_branch path can route.
\`{"kind":"value","fields":{...}}\` fills the listed output fields instead, notes a warning on
the run and REPLACES the whole answer: list every field later steps read. For
classification prefer a value such as "Other" over failing, so one odd message does not
stop a long list; for figures or text a person will read prefer failing and an error branch.
  {"fallback":{"kind":"value","fields":{"category":{"kind":"literal","value":"Other"}}}}
The step result then carries \`checkReport\` {passed, repaired, fallbackUsed, errors}.

**askOnce on an ai_step: reuse the answer.** \`"askOnce":true\` answers an identical request
(same prompt, data, model and settings) once per run: useful for a forEach over items that
repeat. \`{"ttlSeconds":600}\` shortens the window (1..900). \`{"acrossRuns":true}\` also keeps
it for later runs, but only when an admin switched on "Answers from AI steps" in the
organisation's integration cache settings; without it the answer is still reused within the
run. Never reused when the step may use tools, and never in test (dry) runs; say so when a
user wants fresh answers every time.
  {"askOnce":{"ttlSeconds":600,"acrossRuns":true}}

**forEach.concurrency.** An ai_step WITHOUT tools and a data_extraction step may run several
items at once, with \`concurrency\` (1..1000) in its forEach. Results keep the order of the
list. The server cap (default 4) and the model provider's rate limit still apply: a request
over the limit waits, it does not fail. A step with tools ignores it and runs its items one by one.
  {"forEach":{"overRef":"steps.load.output.rows","itemVar":"row","concurrency":3}}

**Long lists: batches in a loop.** Do not send hundreds of items in one prompt. Use a loop with
\`batchSize\` N (1..1000): inside the body \`loop.<var>\` is then a SLICE (an array of up to N items,
\`loop._index\` counts the slices). The body ai_step reads it as an input, returns
\`{results:[{id, ...}]}\`, and checks that the batch comes back whole: \`items\` with
\`sameCountAs "loop.<var>"\` and \`allowedFrom\` on "results[].id" against "loop.<var>" with
\`value "id"\`. builder_add_loop has no batchSize argument: add the loop, then tell the user
to set "Batch size" on it in the editor (and which N you suggest, for example 20). The items
need an id. A loop stops on its first failing batch, and a value fallback would hide a lost
batch, so keep fallback at its default here.
  {"type":"ai_step","prompt":"Sort every message of the batch into one category.","inputs":{"batch":{"kind":"ref","path":"loop.batch"}},"temperature":0,"outputSchema":{"type":"object","properties":{"results":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"category":{"type":"string"}}}}}},"enumFrom":[{"field":"results[].category","ref":"steps.cats.output.rows","value":"name"}],"checks":[{"kind":"items","field":"results","sameCountAs":"loop.batch"},{"kind":"allowedFrom","field":"results[].id","ref":"loop.batch","value":"id"}]}
Downstream, merge the batches with \`steps.<loop>.output.results[*].output.results\` (one flat
list across all batches); do not iterate the loop's own results one by one.

`;

module.exports = { FULL_PROMPT_AI_CHECKS };
