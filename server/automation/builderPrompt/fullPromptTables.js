// @typecheck strict
'use strict';
/**
 * The builder prompt's section on uploaded tables (the `read_table` and `table`
 * steps). Its own file so the workflow rules stay under the file budget; the
 * full prompt (../builderPrompt.js) splices it in after the form rules.
 */

const FULL_PROMPT_TABLES = `## Working with uploaded tables

A spreadsheet or CSV the visitor uploads is a TABLE, not text. The chain is always:
a \`file\` field on the form (accept ".csv,.xlsx"), then \`read_table\` on
\`trigger.output.<field>\`, then ONE \`table\` step holding every edit as an ordered
list of ops. Build both steps in one \`builder_add_steps\` batch.

- **A list of rows is a table source too.** The \`table\` step's source can be a \`code\` step that
  returns rows, or any step whose output is a list of objects: bind \`steps.<code>.output.result\`
  (a list of objects, \`{rows: [...]}\` or \`{columns: [{key, label?}], rows: [...]}\`). The rows
  become a normal table for the next steps. Every row must be an object; the list is capped by
  AUTOMATION_TABLE_MAX_ROWS.
- **Order the ops**: \`pseudonymise\` first when the file holds identifiers (name,
  e-mail, an id), so nothing after it sees them; then \`filter\` and \`select\` to cut rows
  and columns early; then \`derive\` / \`bucket\` / \`join\`; the shape-changing op
  (\`group\`, \`pivot\`, \`groups\`) last. \`describe\` changes nothing and can sit anywhere.
- **Small results come inline**: when the result has at most a few hundred rows,
  \`steps.<table>.output.markdown\` (and \`output.rows\`) hold it. Bind THAT into an
  \`ai_step\` and into a \`generate_document\` (markdown tables render properly). A big
  result only has \`output.table\`, a handle for the next table step. Group or pivot
  before you ask an AI to write anything.
- **Never hand a whole table to an ai_step.** The model needs the few figures that
  matter, not the rows: group first, then pass \`output.markdown\`, and tell the step to
  use only numbers that appear in it.
- **One report per segment**: a \`groups\` op gives \`output.segments\` (each with
  \`label\`, \`n\` and \`rules\`). Run a \`forEach\` over it; inside, a \`table\` step on the
  same source with \`filter {rulesFrom: {kind:"ref", path:"loop.<itemVar>.rules"}}\` gives
  that segment's rows. Groups below \`minN\` never appear as segments.
- **Keep \`datatable\` for small lookups** (a code book, a theme map). It is not the place for an
  uploaded dataset; \`join\` a lookup list onto a table with the \`join\` op instead.
- A wrong column name fails with the name of the op and field: read the error, fix that op.

`;

module.exports = { FULL_PROMPT_TABLES };
