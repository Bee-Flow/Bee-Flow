// @typecheck strict
// Part 4 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { PICK_SOURCES, FORM_FIELD_TYPES, FORM_OPTIONS_HINT, FORM_WIZARD_FIELD_PROPS, FORM_PAGE_FIELD_PROPS, SPLICE_DESCRIPTION } = require('./schemaFragments');
const { CONDITION_RULES_HINT, SWITCH_RULES_EXAMPLE } = require('./ruleExamples');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_4 = [
    {
        type: 'function',
        function: {
            name: 'builder_add_form_page',
            description: 'Append a FURTHER page of the automation\'s public form, shown on the same /f/<token> URL the visitor is already on. Requires the trigger to be kind=form. mode="input" PAUSES the run until the visitor answers — bind their answers as steps.<id>.output.<fieldName>. mode="ending" is the closing page: no questions, and its `title`/`description` are template-interpolated against the finished run, so use {{steps.x.output.y}} there to show the visitor what happened. Do NOT put a form page inside a loop, a parallel branch or a flowlet. A page can build choices from run data (optionsFrom), ask one question per list item (fieldsFrom), hide questions (showIf) and be skipped (`when`): see "Form wizards" in the guide.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    mode: { type: 'string', enum: ['input', 'ending'], description: 'Default "input".' },
                    waitSeconds: { type: 'integer', description: 'mode=input only: how long to wait for the visitor, 60..604800 (1 minute … 7 days). Default 3600.' },
                    when: { type: 'string', description: 'Show this page only when the expression is true (same grammar and scope as a condition: trigger.*, steps.*, vars.*, never {{ }}), e.g. "steps.check.output.verdict == \'retry\'". When false the page is skipped without pausing: its answers are blank and output._skipped is true; a skipped ending page shows nothing. Max 2000 characters.' },
                    form: {
                        type: 'object',
                        description: 'The page. Same shape as the trigger\'s form. Omit `theme` to match the first page (recommended).',
                        properties: {
                            title: { type: 'string' },
                            description: { type: 'string', description: 'Supports {{...}} bindings — this is how a closing page summarises the run.' },
                            submitLabel: { type: 'string' },
                            successMessage: { type: 'string' },
                            fields: {
                                type: 'array',
                                description: 'mode=input only. Empty/omitted for an ending page.',
                                items: {
                                    type: 'object',
                                    properties: {
                                        name: { type: 'string' },
                                        type: { type: 'string', enum: FORM_FIELD_TYPES },
                                        label: { type: 'string' },
                                        required: { type: 'boolean' },
                                        placeholder: { type: 'string' },
                                        options: { type: 'array', items: { type: 'string' }, description: FORM_OPTIONS_HINT },
                                        accept: { type: 'string', description: 'When type=file: a MIME allowlist, e.g. "application/pdf,image/*".' },
                                        maxSizeMb: { type: 'number', description: 'When type=file: 1–25.' },
                                        source: { type: 'string', description: `REQUIRED when type=app_pick: which app the person filling the form searches. One of: ${PICK_SOURCES}. The search runs against THEIR OWN account, so use this instead of asking someone to paste a transcript or forward an email.` },
                                        multiple: { type: 'boolean', description: 'When type=app_pick: let them pick several records. The answer is then a LIST of descriptors instead of one.' },
                                        maxItems: { type: 'number', description: 'When type=app_pick and multiple: 1–10 (default 5).' },
                                        withText: { type: 'boolean', description: 'When type=app_pick: read the record\'s content into the run (default true). Set false when only a reference is wanted.' },
                                        ...FORM_WIZARD_FIELD_PROPS,
                                        ...FORM_PAGE_FIELD_PROPS,
                                        // A file field binds as an OBJECT, never a string:
                                        // trigger.output.<name> is { kind, fileId, filename, mimeType, size,
                                        // text, textTruncated, textError }. `.text` is the extracted content —
                                        // a workbook as one markdown table per sheet, a PDF as its text layer —
                                        // so an ai_step reads the document by binding
                                        // trigger.output.<name>.text, NOT trigger.output.<name>.
                                        //
                                        // An app_pick field binds the same way: trigger.output.<name> is
                                        // { kind:'app_pick', source, app, recordId, title, url, text,
                                        // textTruncated, textError } — or a LIST of those when `multiple`.
                                        // `.text` is the transcript / email body / note, so an ai_step binds
                                        // trigger.output.<name>.text, never trigger.output.<name>.
                                    },
                                    required: ['name', 'type', 'label'],
                                },
                            },
                        },
                    },
                    label: { type: 'string' },
                },
                required: ['form'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_stop_error',
            description: 'Append a step that halts the run with a custom error message. The message is a TEMPLATE — interpolate upstream fields with double curly braces. Use as a guardrail downstream of a condition that detects "we should not continue". EXAMPLE: {message:"Budget exceeded: {{steps.calc.output.delta}}"}.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    message: { type: 'string', description: 'Template string surfaced as the run error.' },
                    label: { type: 'string' },
                },
                required: ['message'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_switch',
            description: `Append a Condition with several outputs. A case is EITHER { name, value } — compared against the step-level expr — OR { name, expr }, carrying its own rule, which is what you want when the outputs test different things. Do not mix the two in one switch. With arrayRef (a path to an upstream list) it works through that list: each case expr is a rule on \`item\`, every output publishes its items at steps.<id>.output.matchesByCase.<case> (Otherwise: matchesByCase.default), and no step-level expr is needed. Wire each case to its next step by passing nextStepIds: { "<caseName>": "<stepId>", "default": "<stepId>" }. EXAMPLE (value style): {expr:"trigger.output.priority",cases:[{name:"urgent",value:"high"},{name:"normal",value:"medium"}],defaultBranch:"fallback"}. EXAMPLE (a list split by file type): ${JSON.stringify(SWITCH_RULES_EXAMPLE)}. ${CONDITION_RULES_HINT} To grow a case branch by appending a NEW step, call an add tool with afterStepId set to this switch's id AND caseName set to the case it belongs to — otherwise the edge is unlabelled and that case dead-ends.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string', description: 'Optional path to an upstream list: the switch then routes each item of it (the rules read `item`). Its outputs are steps.<id>.output.matchesByCase.<case>.' },
                    matchMode: { type: 'string', enum: ['first', 'all'], description: 'With arrayRef: "first" (default) sends an item down the first output it matches; "all" checks every output, so one item can go down several.' },
                    maxItems: { type: 'integer', description: 'With arrayRef: optional cap on how many items are checked.' },
                    expr: { type: 'string', description: 'Without arrayRef and with value-style cases: the expression whose value gets matched.' },
                    cases: { type: 'array', description: 'Checked in order; the first match wins unless matchMode is \'all\'. Each entry is { name, value } (compared against the step-level expr) or { name, expr } (its own rule). One output per entry.', items: { type: 'object', properties: { name: { type: 'string' }, value: {}, expr: { type: 'string', description: 'This output\'s own rule. Inside a list the current item is `item`. When present, `value` is ignored for this case.' } }, required: ['name'] } },
                    defaultBranch: { type: 'string', description: 'Case name to route to when no case matches (otherwise dead-ends).' },
                    nextStepIds: { type: 'object', description: 'Map of case name → existing step id to wire as the branch target. Use this in one shot instead of calling builder_add_* with afterStepId per branch.' },
                    label: { type: 'string' },
                },
                required: ['cases'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_filter',
            description: `Append a Condition that works through a list — keeps the items matching expr. arrayRef points to an upstream array; expr is evaluated per element with the current element bound as \`item\`. Output is { items, count }: the steps after it read steps.<id>.output.items. EXAMPLE: {arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}. ${CONDITION_RULES_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string' },
                    expr: { type: 'string', description: 'The rule on each item (item.<field>), in the shapes listed above.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'expr'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_limit',
            description: 'Append a step that returns the first or last N items of an array. Output is { items, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string' },
                    count: { type: 'integer', description: 'How many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'Default: first.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'count'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_dedupe',
            description: 'Append a step that removes duplicate items. With keyField, dedup by that field; without, dedup by deep equality. Output is { items, removed }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string' },
                    keyField: { type: 'string', description: 'Optional. If set, items with the same value at this field are treated as duplicates.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_aggregate',
            description: 'Append a step that pulls one field across every item of an array into a flat list. Output is { values, count }. EXAMPLE: {arrayRef:"steps.search.output.results",field:"email"} → values is an array of emails.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string' },
                    field: { type: 'string', description: 'Field name to read from each item.' },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_summarize',
            description: 'Append a statistics step over a numeric field of an array. ops: sum, count (length of arrayRef regardless of field), avg, min, max. Output is { result, op, count }.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string' },
                    field: { type: 'string' },
                    op: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'] },
                    label: { type: 'string' },
                },
                required: ['arrayRef', 'field', 'op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_array_op',
            description: `Append an array operation step. Single entry point for filter / limit / dedupe / aggregate / summarize / flatten — pick \`op\` and supply the matching fields. This is the ONLY array tool in the menu.

OPS:
  - filter:    keep items matching expr.    Required: arrayRef, expr.        Output: { items, count }.
  - limit:     first/last N items.          Required: arrayRef, count.       Optional: mode ("first"|"last"). Output: { items, count }.
  - dedupe:    drop duplicates.             Required: arrayRef.               Optional: keyField (dedup by that field; else deep equality). Output: { items, removed }.
  - aggregate: pull one field across items. Required: arrayRef, field.       Output: { values, count }.
  - summarize: numeric stats over a field.  Required: arrayRef, field, fn.   fn ∈ sum|count|avg|min|max. Output: { result, op, count }.
  - flatten:   one row per item of a list inside each item, with the outer item's fields on every row. Required: arrayRef (the outer list), childField (the list inside each item). Optional: keepFields (outer fields to copy; default: the short ones), keepEmpty. Output: { items, count, inputCount, emptyCount }.

arrayRef is a path string (e.g. "steps.search.output.results"), NOT a binding object. EXAMPLE: {op:"filter",arrayRef:"steps.search.output.results",expr:"item.amount > 1000"}.

FILTER RULES: ${CONDITION_RULES_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['filter', 'limit', 'dedupe', 'aggregate', 'summarize', 'flatten'] },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    arrayRef: { type: 'string', description: 'Dotted path to an upstream array, e.g. "steps.search.output.results".' },
                    expr: { type: 'string', description: 'filter only: the rule on each item (item.<field>), in the FILTER RULES shapes.' },
                    count: { type: 'integer', description: 'limit only: how many items to keep.' },
                    mode: { type: 'string', enum: ['first', 'last'], description: 'limit only: default "first".' },
                    keyField: { type: 'string', description: 'dedupe only: field to dedup by; omit for deep-equality dedup.' },
                    field: { type: 'string', description: 'aggregate and summarize: field name on each item.' },
                    fn: { type: 'string', enum: ['sum', 'count', 'avg', 'min', 'max'], description: 'summarize only: which statistic to compute.' },
                    childField: { type: 'string', description: 'flatten only: the list inside each item of arrayRef, e.g. "attachments".' },
                    keepFields: { type: 'array', items: { type: 'string' }, description: 'flatten only: the outer item\'s fields to copy onto each row; omit for the short ones.' },
                    keepEmpty: { type: 'boolean', description: 'flatten only: keep an outer item with an empty inner list as one row; default false.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['op', 'arrayRef'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_datatable',
            description: `Append a step that reads or writes rows of a DATATABLE — an organisation-scoped table whose rows OUTLIVE the run, so one automation can leave data for a later run of itself or for a different automation. This is how an automation remembers WORKING DATA between runs. (A knowledge-write step also outlives the run, but that stores TEXT for an agent to answer from — not data to read back.)

OPERATIONS (pick one):
  - find_rows:    look rows up. Changes nothing.        Optional: where, match, sort, limit, cursor. Output: { rows, returned, found, hasMore, nextCursor }.
  - count_rows:   how many rows match. Reads no row data. Optional: where, match.      Output: { count, found }.
  - add_row:      always inserts a new row.             Required: values.              Output: { row, id, created, updated }.
  - save_row:     updates the matching row, or inserts. Required: values, matchColumn. Output: { row, id, created, updated }.
  - update_rows:  changes every matching row.           Required: values, where (>=1). Output: { updated, truncated }.
  - delete_rows:  removes every matching row.           Required: where (>=1).         Output: { deleted }.

find_rows returns ONE PAGE. \`returned\` is how many rows that page holds — NOT how many rows match; use count_rows for that. To walk a bigger table, feed \`cursor\` from the previous step's \`nextCursor\`. (\`count\` still exists on find_rows as a deprecated alias of \`returned\`; do not use it in new automations.)

delete_rows REFUSES when more than 1000 rows match, rather than deleting the first 1000 and reporting success. update_rows changes the first 1000 and sets \`truncated: true\`.

update_rows and delete_rows REFUSE to save without at least one condition — without one they would change every row in the table.

save_row's \`matchColumn\` MUST also appear in \`values\`: it is how the step recognises the row it wrote last time, so a match column the step does not write makes every run insert a duplicate. The validator refuses it.

A condition whose value resolves to nothing SKIPS the step — for a read as much as for a write. Bind conditions to something that is always there.

\`datatableId\` must be the id of a table that already exists and that the AUTOMATION'S OWNER may write to — never invent an id — or the id builder_create_datatable returned ("pending:<n>" in a preview). If the user needs a table that does not exist yet, create it FIRST with builder_create_datatable {name, fields} and use the id it returns. An existing table the user did not name needs builder_ask_questions {datatableIds} first.

values keys are the column KEYS shown in the Datatables block (e.g. excl_btw for "Excl. btw"); a title is mapped to its key when unambiguous. op aliases (append/insert → add_row, upsert → save_row, list/query → find_rows) are accepted and reported — write the canonical name.

There is NO sql/query field. Pick columns and conditions; the query is built for you.

EXAMPLE: {op:"save_row",datatableId:"tbl_1a2b3c",matchColumn:"email",values:{email:"{{steps.form.output.email}}",status:"new"}}`,
            parameters: {
                type: 'object',
                properties: {
                    op: { type: 'string', enum: ['find_rows', 'count_rows', 'add_row', 'save_row', 'update_rows', 'delete_rows'] },
                    datatableId: { type: 'string', description: 'Id of an EXISTING datatable from the catalog, or the id builder_create_datatable returned ("pending:<n>" in a preview). An existing table the user did not name needs builder_ask_questions {datatableIds} first. Never invent one.' },
                    datatableKey: { type: 'string', description: 'That same table\'s `key`, copied EXACTLY as the catalog shows it beside the id. Advisory only — nothing reads it at run time; it is what lets an export/import re-link the step, because an exported automation never carries another workspace\'s table id. Leave it out if you do not have the key; never guess one, or an import re-links to the wrong table.' },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    where: {
                        type: 'array',
                        description: 'Conditions. Each is {field, op, value}; op is one of eq, neq, gt, gte, lt, lte, contains, notContains, startsWith, endsWith, in, notIn, between, isNull, isNotNull. `in`/`notIn` take an ARRAY value; `between` takes [min, max].',
                        items: {
                            type: 'object',
                            properties: {
                                field: { type: 'string' },
                                op: { type: 'string' },
                                value: { description: 'A literal, or a {{...}} template referencing an upstream step.' },
                            },
                            required: ['field', 'op'],
                        },
                    },
                    match: { type: 'string', enum: ['all', 'any'], description: 'How the conditions combine: "all" (default) or "any". There are no nested groups.' },
                    values: { type: 'object', description: 'Column → value for a write. Values may be {{...}} templates.' },
                    matchColumn: { type: 'string', description: 'save_row only: the column that decides update vs insert. Must be unique in the table.' },
                    sort: {
                        type: 'array',
                        description: 'find_rows only: which column orders the rows. ONLY THE FIRST ENTRY IS USED (the row id breaks ties). Defaults to newest first.',
                        items: {
                            type: 'object',
                            properties: { field: { type: 'string' }, dir: { type: 'string', enum: ['asc', 'desc'] } },
                            required: ['field'],
                        },
                    },
                    cursor: { type: 'string', description: "find_rows only: the previous page's `nextCursor`, usually as {{steps.<id>.output.nextCursor}}. Leave it out for the first page." },
                    limit: { type: 'integer', description: 'find_rows only: how many rows at most (1-1000, default 50).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['op', 'datatableId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_create_datatable',
            description: `CREATE a new Studio datatable NOW (at design time) — for an automation that must write rows into a table that does not exist yet ("extract the invoices into a new table called invoice"). This is NOT a step: nothing runs later. In Build directly (and over MCP) the table exists when this answers. In a preview (Approve each change, or a change waiting for Apply) it is STAGED with datatableId "pending:<n>" — bind steps to that id — and created when the user presses Apply. A same-named existing table is only reused once the user chose it. Then write into it with builder_add_datatable {op:"add_row", datatableId:<the id this returns>, values:{<columnKey>: binding}}.

Give the columns the automation will write: name + type (text | number | date | datetime | bool | select with options | multiselect | file); a key is derived from the name when you leave it out ("Excl. btw" → excl_btw). Use builder_add_datatable directly when the Datatables block already lists a fitting table the user named.`,
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'The table\'s title as the person sees it in Studio > Datatables, e.g. "Facturen".' },
                    description: { type: 'string', description: 'One sentence: what the rows are.' },
                    fields: {
                        type: 'array',
                        description: 'The columns: [{ name, type, key?, options? (select/multiselect), required? }]. At most 40.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' },
                                key: { type: 'string', description: 'snake_case; derived from name when omitted.' },
                                type: { type: 'string', enum: ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file'] },
                                options: { type: 'array', items: { type: 'string' } },
                                required: { type: 'boolean' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                },
                required: ['name', 'fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_knowledge_write',
            description: `Append a step that WRITES text into a KNOWLEDGE BASE, so an agent can answer from it later. Like a datatable, its effect outlives the run — but where a row is data somebody reads back, a knowledge-base document is text an agent will state as FACT, with a citation. Only write things that are true and finished.

Use it for: a resolved support ticket becoming an article; a meeting's decisions becoming searchable; a nightly summary of a system's state. Do NOT use it to stash working data between steps — that is what \`builder_add_datatable\` is for.

\`knowledgeBaseId\` must be a base that already exists and that the AUTOMATION'S OWNER may MANAGE — being able to read a base is not permission to add to it. You cannot create one, and you must never invent an id: ask the user for it, or take it from something they showed you. If they need a base that does not exist yet, say so and stop. The save is refused with \`knowledge_write.kb_not_manageable\` if the owner cannot write there, and the same check runs again at run time.

\`content\`, \`title\` and \`sourceUri\` are TEMPLATE STRINGS, not binding objects: write "{{steps.summary.output.text}}" directly, the same way generate_document takes its content.

\`sourceUri\` is what makes the step idempotent. The same sourceUri REPLACES its own document instead of adding a second, so give it something stable and unique per subject — a ticket URL, a record id, "meeting:{{trigger.output.id}}". Without one, an automation that runs nightly leaves a new document every night and nobody can tell why the base grew.

A run where \`content\` resolves to nothing SKIPS rather than storing an empty document. A dry run reports what it WOULD write and stores nothing.

EXAMPLE — each resolved ticket becomes an article: {knowledgeBaseId:"kb_9f2",title:"{{loop.ticket.subject}}",content:"{{steps.article.output.text}}",sourceUri:"ticket:{{loop.ticket.id}}",forEach:{overRef:"steps.tickets.output.rows",itemVar:"ticket"}}`,
            parameters: {
                type: 'object',
                properties: {
                    knowledgeBaseId: { type: 'string', description: 'Id of an EXISTING knowledge base the automation owner may MANAGE. Take it from the "Knowledge bases you may use" block in the context, a WRITABLE one — never invent one; anything else is refused at save.' },
                    content: { type: 'string', description: 'The text to store. A {{...}} template — usually the whole output of an earlier step, e.g. "{{steps.summary.output.text}}".' },
                    title: { type: 'string', description: 'What the document is called where a person browses the base. A {{...}} template. Defaults to "Untitled".' },
                    sourceUri: { type: 'string', description: 'A stable, unique reference for THIS subject, so a later run replaces this document instead of adding another — e.g. "ticket:{{loop.ticket.id}}". Strongly recommended on anything that runs more than once.' },
                    nearDuplicateStrategy: { type: 'string', enum: ['skip', 'merge', 'replace', 'add'], description: 'What to do when the base already holds near-identical text under a DIFFERENT source: skip (default, keep what is there), merge, replace, or add anyway.' },
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId. true: INSERT it between afterStepId and its successor(s).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['knowledgeBaseId', 'content'],
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_4 };
