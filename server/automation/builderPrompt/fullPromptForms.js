// @typecheck strict
'use strict';
/**
 * The "Form wizards" section of the FULL builder system prompt (and so of the
 * MCP guide, which ships the full prompt): what a form can do beyond plain
 * questions. ../builderPrompt.js splices it after the workflow text and
 * before the pitfalls tail. Examples stay generic on purpose: a request form,
 * rating each item of a list, a document upload that may need a second try.
 * The lean prompt does not carry it (the small menu drops these attributes).
 */

const FULL_PROMPT_FORMS = `

## Form wizards (trigger kind=form and form_page steps)

A form is a short wizard when the trigger's page and the form_page steps after it
ask only what is still needed. Everything below needs no code step.

**Question types.** Besides text, textarea, email, number, date, select, checkbox,
file and app_pick: \`radio\` (one choice, shown as buttons, answers like select),
\`multiselect\` (several choices; the answer is a LIST of option values;
\`minSelected\` / \`maxSelected\` bound it) and \`info\` (display only: \`content\` is
markdown, nothing is asked or stored). Use radio for 2-4 choices, select for
longer lists, multiselect when more than one may apply, info for an explanation.
An option's text IS its value: a later switch or condition matches that exact text.

**Inline rules.** number and date take \`min\` / \`max\` (a date as YYYY-MM-DD),
text / textarea / email take \`minLength\` / \`maxLength\`, text / textarea take
\`pattern\` (the WHOLE answer must match; RE2 syntax) with \`patternMessage\` (the
sentence the visitor reads). A broken rule shows an inline error; the page does
not submit. Rules only judge a filled-in answer: add required for "must answer".

**showIf: hide a question.** \`showIf: "form.contact == \\"email\\""\` shows the
question only for that answer. Other forms: \`contains(form.topics, "billing")\`,
\`!isEmpty(form.company)\`. Only \`form.<name>\` of questions ABOVE it on the same
page may be used. The server checks it again: a hidden required question never
blocks, and a hidden answer is dropped (blank), so never rely on it.

**optionsFrom: choices from run data (form_page only).** On a select, radio or
multiselect: \`optionsFrom: {ref:"steps.load.output.rows", value:"id", label:"name", hint:"note"}\`.
\`ref\` is a run path to a list (no {{ }}), \`value\` / \`label\` / \`hint\` are paths
inside one item (omit all three for a list of plain values), \`limit\` caps the
count. The ANSWER is the item's \`value\`; the label is display only. So route with
a condition or switch on the VALUE (for example an id), never on label text. An
empty list shows "no options" and the question is not required.

**fieldsFrom: one question per list item (form_page only).** A text, textarea,
number, date, select, radio or checkbox with \`fieldsFrom: {ref, value, label, hint, limit}\`
is asked once for every item, with the item's label as the question: "rate each
line of an order", "confirm every document found". The answer binds as
steps.<page>.output.<name> = a LIST of {key, label, answer}, one entry per item
(key = the item's value). Feed it to a for-each step or an ai_step. Keep the
question \`name\` short (54 characters at most).

**\`when\` on a page: skip it without pausing.** \`builder_add_form_page({when:"steps.check.output.verdict == \\"retry\\""})\`
uses the condition grammar (trigger.*, steps.*, vars.*; no {{ }}). When false the
page never shows and the run does not pause: its answers are blank and
steps.<page>.output._skipped is true. A skipped ending page shows nothing.

**Stop early with a message.** No separate end node: put a condition before the
page; on the branch that must stop, add a form_page mode "ending" whose
description is templated ("We cannot continue: {{steps.check.output.reason}}"),
and leave that branch without further steps.

**Two entry points, ONE form.** Never add a second form trigger. Ask the choice
first with a radio on the trigger ("I want to: report / request"), then put
\`when\` on the later pages (\`trigger.output.kind == "request"\`), or branch with a
switch on the choice VALUE and give each branch its own pages.

**A bounded retry without a loop.** For "upload a document, and allow ONE more try
if the check fails": (1) put the check in a flowlet; (2) after the first upload
page call that flowlet; (3) add a condition on the first check's verdict; (4) on
its failure branch only, add the second form_page (asking for the file again) and
then the SAME flowlet again on the new file, so the second call never runs when
the first check passed; (5) end both branches in ONE step (wire the condition's
passing branch and the last retry step to it, \`thenStepId\` / \`elseStepId\` take
an existing step); (6) in that step and after it bind
\`coalesce(steps.<second page>.output.file, steps.<first page>.output.file)\` for the
file and \`coalesce(steps.<second call>.output.verdict, steps.<first call>.output.verdict)\`
for the verdict. A step that did not run on the passing branch reads as empty
(null), which is what coalesce skips. Never bind the second call's result without
that coalesce, and never call the flowlet a second time outside the failure
branch. Form pages cannot sit inside a loop or a flowlet, which is why the retry
is unrolled.

**Several people at once.** A wizard that many people fill in at the same time
needs "Run at the same time" set to "Allowed at the same time" (the automation's
runPolicy.concurrency "parallel"). The builder tools cannot set it: tell the user
to change it in the automation's settings, otherwise a second visitor waits for
the first to finish.

`;

module.exports = { FULL_PROMPT_FORMS };
