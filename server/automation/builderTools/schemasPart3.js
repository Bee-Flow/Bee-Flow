// @typecheck
// Part 3 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { BINDING_HINT, SPLICE_DESCRIPTION } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_3 = [
    {
        type: 'function',
        function: {
            name: 'builder_add_presentation',
            description: `Append a step that turns slides into a real PowerPoint (.pptx) — or a PDF deck — in the organisation's house style, and keeps the file. Use it whenever the user wants "a presentation", "slides", "a deck", "a PowerPoint", "een presentatie". \`slides\` is THE input and takes three shapes: (1) SIMPLEST — the markdown an ai_step wrote: slides:"{{steps.write.output.text}}"; tell that ai_step to write "# Title" once and "## " for every slide with "- " bullets under it (optional "### " sub-headings — two = columns, three to six = cards, "### Title {icon: shield}" for an icon —, "> " quote, a "|" table, "<!-- notes: … -->" speaker notes; for VISUALS a \`\`\`chart block ("type: bar", "labels: Q1, Q2", "Omzet: 10, 20") or "<!-- chart: bar -->" above a table, a \`\`\`stats block ("€ 1,2M | Omzet | +12%" per line), "<!-- layout: timeline -->" for steps). (2) A LIST of slide steps: slides:["{{steps.s1.output.slide}}","{{steps.s2.output.slide}}"] — each entry is ONE whole reference and nothing else. (3) ONE SLIDE PER ITEM: a slide step with forEach, then slides:"{{steps.<slide>.output.results[*].output.slide}}" (a loop body ending in a slide step works the same with the loop's id). Output is {fileId,filename,mimeType,size,format,slideCount,sourceHandle}; there is deliberately NO url. TO OFFER IT AS A DOWNLOAD: add a form_page (mode:"ending") whose form.fields contains {type:"download", label:"…", fileId:"{{steps.<this step's id>.output.fileId}}"}. TO KEEP IT IN NEXTCLOUD: add nextcloud_upload_file with path:"/Presentaties/<name>.pptx" and sourceHandle:{kind:"ref",path:"steps.<this step's id>.output.sourceHandle"} — it opens in Nextcloud Office. The file is deleted after \`expiresInDays\` (default 7).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: 'Default false: the new step is added BESIDE the current successor of afterStepId (that edge stays, so the two run in parallel). true: INSERT the new step between afterStepId and its current successor(s) - the successor edge is re-pointed to the new step, so downstream steps can depend on it. Pass branch/caseName as well when the anchor is a condition/switch.' },
                    title: { type: 'string', description: 'Deck title on the cover and the default filename. Template string. Falls back to the "# " title of a markdown outline.' },
                    subtitle: { type: 'string', description: 'Cover subtitle (audience, date). Template string.' },
                    slides: { description: 'THE slides: a template string (a markdown outline, a loop result reference) OR a list of whole references / inline {title, content} objects. See the three shapes above.' },
                    fileName: { type: 'string', description: 'Filename WITHOUT extension (that follows from `format`). Template string. Falls back to the title.' },
                    format: { type: 'string', enum: ['pptx', 'pdf'], description: 'Default pptx (PowerPoint / Nextcloud Office). pdf = the same deck as a landscape PDF.' },
                    houseStyle: { type: 'boolean', description: "Default true: the organisation's colours, font, logo and footer. false ONLY when the user asks for another brand or an unbranded deck." },
                    preset: { type: 'string', enum: ['band', 'clean', 'bold', 'dark'], description: 'Optional look: band = white slides with a coloured title band (default); clean = white, accent titles; bold = accent-coloured slides; dark = charcoal slides. Only when the user asks for a style.' },
                    accent: { type: 'string', description: 'Optional accent colour "#RRGGBB" (template string) — only when the user names a colour or another brand.' },
                    font: { type: 'string', enum: ['Calibri', 'Arial', 'Helvetica', 'Verdana', 'Segoe UI', 'Trebuchet MS', 'Century Gothic', 'Georgia', 'Cambria', 'Times New Roman', 'Garamond', 'Consolas'], description: 'Optional typeface for the deck.' },
                    coverStyle: { type: 'string', enum: ['accent', 'light', 'split'], description: 'Optional cover: accent block (default), light, or split panel.' },
                    tableStyle: { type: 'string', enum: ['banded', 'lines', 'minimal'], description: 'Optional table look: banded (default), lines, minimal.' },
                    logo: { type: 'string', description: 'Optional logo on every slide: the imageUrl of a generate_image step or a data: URL, or "none" to leave the house-style logo off. Template string.' },
                    logoPlacement: { type: 'string', enum: ['footer', 'corner', 'cover', 'none'], description: 'Where the logo sits (default: house style).' },
                    background: { type: 'string', description: 'Optional slide background "#RRGGBB" (template string); text colours adapt for contrast.' },
                    footerText: { type: 'string', description: 'Optional line in every slide footer, e.g. "Vertrouwelijk · {{trigger.date}}". Template string.' },
                    template: { type: 'string', enum: ['none'], description: '"none" = plain slides instead of the house-style template deck. Leave out otherwise.' },
                    saveCopy: { type: 'boolean', description: 'Default false. true ALSO keeps the deck in Studio → Documents as an editable presentation (opens in Bee Flow). Off for an automation that runs often.' },
                    expiresInDays: { type: 'number', description: 'How long the download keeps working, 1..90 (default 7). The file is deleted afterwards.' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['slides'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_data_extraction',
            description: `Append a step that pulls NAMED, TYPED fields out of a piece of text — an invoice, an e-mail body, the text of a PDF, a web page. PREFER THIS OVER AN ai_step FOR EXTRACTION: an ai_step is for judgement and writing (classify, summarise, draft a reply); this step is for "read these values out of that text". It runs on the ONE extraction model the administrator configured (small, fast, deterministic, thinking off) — NOT on the automation's model tier, so there is no modelTier to pick. \`fields\` IS the output shape, so no outputSchema is needed: the output is exactly one object with exactly the declared names — steps.<id>.output.<name>, or loop.<itemVar>.output.<name> inside a fan-out — and a field the text does not contain is null (a field marked required:true FAILS the step instead, so an unreadable document can be routed to an on_error branch). Numbers are real JSON numbers even when the text says "€ 1.554,25"; dates are "YYYY-MM-DD" strings. \`source\` is ONE binding to the text to read. source, fields and instructions sit at the TOP LEVEL of the args — this step has NO inputs map (that is integration_action vocabulary). Use forEach to extract the same fields from every file: {source:{kind:"ref",path:"loop.f.output.content"}, forEach:{overRef:"steps.<read>.output.results", itemVar:"f"}}. forEach.concurrency (1..1000) lets several files be read at once. EXAMPLE: {source:{kind:"ref",path:"steps.read.output.content"}, fields:[{name:"factuurnummer",type:"string",description:"Invoice number",required:true},{name:"datum",type:"date",description:"Invoice date"},{name:"totaal_incl_btw",type:"number",description:"Total including VAT"}], instructions:"Amounts are in euros."}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    source: { type: 'object', description: 'The text to read, as ONE binding: {kind:"ref", path:"steps.<id>.output.<field>"} or {kind:"template", value:"…{{steps.x.output.y}}…"}. Inside a forEach: {kind:"ref", path:"loop.<itemVar>.output.content"}. Never a literal.' },
                    fields: {
                        type: 'array',
                        minItems: 1,
                        maxItems: 30,
                        description: 'The fields to extract, IN ORDER — this list is the output shape. 1..30 rows.',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string', description: 'Lowercase letters, digits and underscores, starting with a letter, max 40 chars (e.g. "invoice_date"). Becomes the output key steps.<id>.output.<name>. Unique within the step.' },
                                type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'], description: 'string | number (a real JSON number, coerced from "1.554,25" too) | boolean | date (a "YYYY-MM-DD" string). Default string.' },
                                description: { type: 'string', description: 'What to look for, in one line — the model reads this. E.g. "Total amount including VAT".' },
                                required: { type: 'boolean', description: 'Default false. true: the step FAILS when the text does not contain this field, so the failure can be handled on an on_error branch instead of a null flowing downstream.' },
                            },
                            required: ['name', 'type'],
                        },
                    },
                    instructions: { type: 'string', description: 'Optional extra guidance for the model, max 2000 chars — units, language, which of two similar dates. NOT a prompt: the step builds its own. E.g. "Amounts are in euros; the invoice date is the one after Factuurdatum."' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['source', 'fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_set',
            description: `Append an "Edit data" (set) step. Two modes, both free at run time — prefer this over an ai_step for restructuring data. SINGLE (no arrayRef): produces one explicit object from the fields map. LIST (arrayRef set to an upstream array): every row keeps its columns and gets the fields ADDED (evaluated per row — the row is \`item\`, e.g. {kind:"expr",value:"lower(item.email)"}), then \`operations\` run on the whole table IN ORDER; output becomes { items, count } — bind downstream as steps.<id>.output.items. To read values out of JSON text, use an expr binding with the parseJson function: {kind:"expr",value:"parseJson(steps.h.output.body, \\"order.total\\")"} — this replaces the old parse_json step. ${BINDING_HINT} EXAMPLE single: {fields:{name:{kind:"literal",value:"Alice"},email:{kind:"ref",path:"trigger.output.from"}}}. EXAMPLE list: {arrayRef:"steps.g.output.results",fields:{sender:{kind:"expr",value:"lower(item.from)"}},operations:[{op:"groupId",target:"thread",keys:["sender","subject"]},{op:"rowId",target:"id"}]}.`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    fields: { type: 'object', description: `Map of fieldName → binding. In list mode each binding is evaluated per row with the row as \`item\` (and \`_index\`). ${BINDING_HINT}` },
                    arrayRef: { type: 'string', description: 'Dotted path to an upstream ARRAY, e.g. "steps.<id>.output.items". Presence switches the step to list mode. Cannot be combined with forEach.' },
                    operations: {
                        type: 'array',
                        description: 'List mode only — whole-table operations, applied AFTER the per-row fields, strictly in listed order (sort before rowId numbers the sorted order). Column names are top-level keys. Ops: {op:"rowId",target,start?} number every row 1..N; {op:"groupId",target,keys:[col,…]} same id for rows with equal values in the key column(s) (case-insensitive, first-appearance numbering); {op:"rename",from,to}; {op:"keep",keys:[…]} keep only these columns; {op:"remove",keys:[…]}; {op:"sort",key,direction?:"asc"|"desc"} (numeric when possible, missing values last). Max 20.',
                        items: { type: 'object' },
                    },
                    maxItems: { type: 'number', description: 'List mode only — optional input cap (tightens the platform ceiling of 10000; over the cap the run fails loudly).' },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins.' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['fields'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_note',
            description: 'Add a free-floating sticky-note annotation to the canvas — a place to explain WHY a branch exists, leave a TODO, or document a decision for whoever opens this automation next. It never runs, is never wired to anything (no afterStepId/branch — a note has no edges at all), and is not part of the flow. Use it instead of a comment nobody else can see.',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: 'The note\'s text. Plain text (no bindings, no templates — it never runs).' },
                    position: {
                        type: 'object',
                        description: 'Where the note sits on the canvas. Omit to let the canvas place it; a human editing the same automation will likely move it anyway.',
                        properties: { x: { type: 'number' }, y: { type: 'number' } },
                    },
                    size: {
                        type: 'object',
                        description: 'Note box size in canvas units, e.g. { width: 220, height: 140 }. Omit for the default size.',
                        properties: { width: { type: 'number' }, height: { type: 'number' } },
                    },
                    color: { type: 'string', enum: ['blue', 'green', 'amber', 'orange', 'rose', 'red', 'cyan', 'slate'], description: 'Optional swatch. Omit for the default colour.' },
                    label: { type: 'string' },
                },
                required: ['text'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_create_layer',
            description: 'Create an inline Flowlet — a named, reusable sub-flow stored INSIDE this automation (definition.layers). The skeleton is a layer_input trigger (declaring the input params) wired to a layer_output "Return" step. Workflow: 1) builder_create_layer → returns {layerKey}; 2) populate it by calling the normal builder_add_* tools with scope:"<layerKey>"; 3) bind its outputs in the layer_output step (builder_set_layer_contract outputFields); 4) run it from the main flow via builder_add_call_layer. Inside a flowlet, bind inputs as trigger.output.<param>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name (the key is derived from it).' },
                    params: {
                        type: 'array',
                        description: 'Input contract. Each param is available inside the flowlet as trigger.output.<name>.',
                        items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string', description: 'string | number | boolean | object | array (informational).' }, required: { type: 'boolean' } }, required: ['name'] },
                    },
                },
                required: ['title'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_inline_layer',
            description: 'Fold a flowlet INTO the flow that calls it: the flowlet\'s steps move into the calling flow at the call_layer step\'s position (fresh ids), the edges are re-wired, the flowlet\'s inputs (trigger.output.<param>) become the call\'s input bindings and every downstream read of the call (steps.<callId>.output.<field>) becomes the flowlet\'s Return binding for that field; the call step is removed, and the flowlet with it when nothing else calls it. Use it ONLY when the user or the approved plan asks to inline / flatten / merge a flowlet into the main flow. It refuses (and changes nothing) when a binding cannot be mapped without guessing, and says which; the call then has an error branch, runs per item (forEach), or sits in a loop body. Pass the id of the call_layer step; use scope when that step is itself inside a flowlet.',
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string', description: 'Id of the call_layer step to replace by the flowlet\'s steps.' },
                },
                required: ['stepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_layer_contract',
            description: 'Update a flowlet\'s contract. `params` replaces the layer_input trigger params (inputs the caller must bind). Set the flowlet\'s RETURN value with `outputs`: a map of fieldName → binding that writes the layer_output ("Return") step directly — this is THE way a flowlet returns data; never add a separate `set`/return step to hold it. (`outputFields` is a legacy alternative that only declares the key set, leaving bindings empty.) The flowlet already contains exactly one layer_output step — these args edit it in place.',
            parameters: {
                type: 'object',
                properties: {
                    layerKey: { type: 'string', description: 'Key in definition.layers.' },
                    params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputs: { type: 'object', description: 'Map of return-field name → binding, e.g. { "invoices": { "kind":"ref", "path":"steps.agg1.output.values" } }. Declares AND binds each field on the layer_output step in one call. A code step\'s returned fields are read under output.result: { "count": { "kind":"ref", "path":"steps.code1.output.result.count" } }.' },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Legacy: declare return field NAMES only (bindings start empty). Prefer `outputs` so the flowlet actually returns data.' },
                },
                required: ['layerKey'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layer',
            description: 'DELEGATE building a whole flowlet to a focused sub-agent (thinking model). Give it a clear `instruction` describing what the flowlet should do, plus its `params` (inputs) and `outputFields` (what it returns). The sub-agent creates the flowlet and builds every step inside it, then returns {layerKey, outputFields, summary}. Prefer this over hand-building a non-trivial flowlet step-by-step. After it returns, wire the flowlet into the main flow with builder_add_call_layer({layerKey, inputs:{...}}) and bind its results as steps.<callId>.output.<field>.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Human-readable flowlet name.' },
                    instruction: { type: 'string', description: 'Precise description of what this flowlet must do (the sub-agent builds it end to end).' },
                    params: { type: 'array', description: 'Inputs the flowlet accepts (bound by the caller; seen inside as trigger.output.<name>).', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                    outputFields: { type: 'array', items: { type: 'string' }, description: 'Field names the flowlet should return.' },
                },
                required: ['title', 'instruction'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_generate_layers',
            description: 'DELEGATE building SEVERAL independent flowlets AT ONCE — up to 3 sub-agents (thinking model) run in parallel, one per flowlet. Use this when a complex automation decomposes into multiple reusable sub-flows that do NOT depend on each other. Each entry needs a `title` + `instruction` (+ optional params/outputFields). Returns the built flowlets with their keys + outputFields; wire each into the main flow with builder_add_call_layer afterwards. The flowlets must be independent — a flowlet here may reference only PRE-EXISTING flowlets, not its siblings in this same call.',
            parameters: {
                type: 'object',
                properties: {
                    layers: {
                        type: 'array',
                        description: 'The flowlets to build in parallel (max 3 run concurrently; more queue).',
                        items: {
                            type: 'object',
                            properties: {
                                title: { type: 'string' },
                                instruction: { type: 'string', description: 'What this flowlet must do.' },
                                params: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, type: { type: 'string' }, required: { type: 'boolean' } }, required: ['name'] } },
                                outputFields: { type: 'array', items: { type: 'string' } },
                            },
                            required: ['title', 'instruction'],
                        },
                    },
                },
                required: ['layers'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_plan',
            description: 'Record (and update) your own to-do list for building this automation, shown to the user as a live checklist. Call it FIRST for any multi-step build (with `todos`), then update progress with the cheap `markDone` diff form. NEVER send this tool as your only call in a reply — always bundle it with the build calls it describes. It does not change the automation.',
            parameters: {
                type: 'object',
                properties: {
                    todos: {
                        type: 'array',
                        description: 'The full ordered checklist (replaces the previous one). Use for the initial plan or a restructure.',
                        items: { type: 'object', properties: { text: { type: 'string', description: 'Short task description.' }, done: { type: 'boolean', description: 'true once completed.' } }, required: ['text'] },
                    },
                    markDone: {
                        type: 'array',
                        items: { type: 'integer' },
                        description: '0-based indices of existing todos to flip done:true. Cheaper than resending todos — use this for progress updates, bundled with your next build call.',
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_call_layer',
            description: `Append a "call_layer" step that runs one of this automation's inline flowlets (definition.layers) and returns its layer_output fields, bindable downstream as steps.<id>.output.<field>. Provide the layerKey plus an inputs map binding each declared flowlet param (the flowlet sees them as trigger.output.<param>). ${BINDING_HINT} Recursion is rejected — a flowlet cannot (transitively) call itself. Use scope to place the call INSIDE another flowlet (sibling calls are allowed).`,
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    layerKey: { type: 'string', description: 'Key of the flowlet in definition.layers (create one via builder_create_layer).' },
                    inputs: { type: 'object', description: `Map of flowlet-param → binding. ${BINDING_HINT}` },
                    branch: { type: 'string', enum: ['then', 'else'], description: 'When afterStepId is a condition: which branch this step begins. Omit to auto-fill (then first, else second).' },
                    caseName: { type: 'string', description: 'When afterStepId is a switch: the case name (or "default") this step begins.' },
                    label: { type: 'string' },
                },
                required: ['layerKey'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_datetime',
            description: 'Append a date/time operation. ops: now (current time), parse (string→ISO), format (ISO→formatted string), addDays/addHours/addMinutes (offset by amount), diff (two refs → numeric diff in unit), extract (year/month/day/hour/minute/dayOfWeek). EXAMPLES: {op:"now"} | {op:"addDays",input:"trigger.output.timestamp",amount:7} | {op:"format",input:"steps.x.output.iso",format:"yyyy-MM-dd"} | {op:"diff",input:"trigger.output.start",input2:"trigger.output.end",unit:"hours"}. To work through a LIST (a whole column of dates), set arrayRef to the list and address the row with `item`: {op:"extract",part:"day",arrayRef:"steps.x.output.results",input:"item.updated"} — every row keeps its columns and gains a `day` column.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    op: { type: 'string', enum: ['now', 'parse', 'format', 'addDays', 'addHours', 'addMinutes', 'diff', 'extract'] },
                    input: { type: 'string', description: 'Path to a date value (ISO string, or epoch seconds/ms number). A date that does not exist (2026-02-30) fails the step. Omit for op:now.' },
                    input2: { type: 'string', description: 'Second date path. Required for op:diff.' },
                    amount: { type: 'number', description: 'Offset amount (positive or negative). Required for addDays/addHours/addMinutes.' },
                    format: { type: 'string', description: 'Format string with tokens yyyy/MM/dd/HH/mm/ss. Required for op:format.' },
                    part: { type: 'string', enum: ['year', 'month', 'day', 'hour', 'minute', 'second', 'dayOfWeek'], description: 'Required for op:extract.' },
                    unit: { type: 'string', enum: ['days', 'hours', 'minutes', 'seconds'], description: 'Required for op:diff.' },
                    arrayRef: { type: 'string', description: 'LIST MODE: path to an upstream list, e.g. steps.x.output.results. The operation then runs per ROW and the result is ADDED AS A COLUMN to every row; `input` addresses the row as `item`, e.g. "item.updated". Output is {items,count}. Omit entirely to work on one date.' },
                    target: { type: 'string', description: 'List mode only: the name of the column the result goes into. Defaults to the part (op:extract), else the operation name.' },
                    timezone: { type: 'string', description: 'IANA timezone, e.g. Europe/Amsterdam. Default UTC. It sets the wall clock that op:format and op:extract use, how a date WITHOUT a zone ("2026-07-01 09:00") is read, and makes op:addDays keep the clock time across a daylight-saving change. Output iso stays UTC.' },
                    epochUnit: { type: 'string', enum: ['auto', 'seconds', 'ms'], description: 'How a NUMBER input is read. auto (default): below 1e11 is epoch seconds, otherwise milliseconds. Set seconds or ms to force one (needed for milliseconds between 1966 and 1970, which are negative and small).' },
                    label: { type: 'string' },
                },
                required: ['op'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_wait',
            description: 'Append a step that pauses the run for N seconds (1..86400). Use for simple rate limiting or to give an external service time to settle. Dry-run skips the wait.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    seconds: { type: 'integer', description: 'Number of seconds to wait. Capped at 86400 (24h).' },
                    label: { type: 'string' },
                },
                required: ['seconds'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_approval',
            description: 'Append a step that PAUSES the run until a person approves or rejects it. `prompt` is what the approver reads and is template-interpolated, so use {{steps.x.output.y}} to quote the actual thing being approved. Optional richness: `details` (markdown, interpolated) for context; `attachments` (bindings to fileIds from generate_document steps) so the approver can download the document being approved; `fields` (form-contract questions — text/textarea/email/number/date/select/checkbox, NEVER file) whose answers land at steps.<id>.output.answers.<name>. `assignee` routes the decision to one person ({userId}) or one org group ({groupId}); without it the automation\'s owner decides. On APPROVE the run continues and later steps can bind steps.<id>.output.approved / .by / .reason / .decidedAt (and .answers.*). On REJECT the run ENDS — never wire a "rejected" branch. For approvals that need SEVERAL people in ORDER (team lead, then finance, then a director), use `stages` — up to 5 named steps, each with its own approvers, its own rule, and an optional `when` condition. Do NOT put an approval inside a loop, a parallel branch or a flowlet, and never set forEach on it.',
            parameters: {
                type: 'object',
                properties: {
                    afterStepId: { type: 'string' },
                    splice: { type: 'boolean', description: SPLICE_DESCRIPTION },
                    prompt: { type: 'string', description: 'The question the approver sees, e.g. "Send the {{steps.quote.output.total}} quote to {{trigger.output.client}}?". Supports {{...}} bindings.' },
                    expiresInHours: { type: 'integer', description: 'How long the approval may sit before the run is closed as expired, 0..720 (30 days). 0 = no deadline. Default 168 (7 days).' },
                    assignee: { type: 'object', description: 'Who decides: { userId: "..." } for one person or { groupId: "..." } for an org group (any member may decide, first decision wins). Must belong to the owner\'s organisation. Omit = the owner decides.' },
                    details: { type: 'string', description: 'Optional markdown shown under the question, template-interpolated — put the context the approver needs to judge (amounts, recipients, the drafted text).' },
                    attachments: { type: 'array', description: 'Up to 5 items of { binding, label? } where binding resolves to a fileId an earlier generate_document step produced, e.g. { binding: "{{steps.doc.output.fileId}}", label: "The quote (PDF)" }.', items: { type: 'object' } },
                    fields: { type: 'array', description: 'Up to 20 extra questions for the approver (form-contract fields: name, label, type, required, options...). Answers bind downstream as steps.<id>.output.answers.<name>. type "file" is refused.', items: { type: 'object' } },
                    approvers: { type: 'array', description: 'A PANEL of up to 10 seats, each { userId } or { groupId } (a group seat is filled by whichever member votes first). Use INSTEAD of assignee. How votes resolve is set by `rule`. Downstream, steps.<id>.output.votes lists every vote.', items: { type: 'object' } },
                    rule: { type: 'string', enum: ['all', 'first', 'quorum'], description: 'Panel decision rule. "all" (default): every seat must approve — ONE reject declines immediately. "first": the first vote decides for everyone. "quorum": approved at `quorum` approvals, declined once that number is unreachable.' },
                    quorum: { type: 'integer', description: 'For rule="quorum": how many approvals are needed (1..number of seats), e.g. 2 of 3.' },
                    finalApprover: { type: 'object', description: 'Optional FINAL sign-off stage: after the panel (or single approver) says yes, this one person ({ userId }) or group ({ groupId }) has the last word. The request only counts as approved after their decision.' },
                    stages: { type: 'array', description: 'A SEQUENTIAL CHAIN of up to 5 approval stages, asked one after another — use INSTEAD of assignee/approvers/finalApprover (setting both is refused, because the extra approver would never be asked). Each stage is { name, description?, approvers: [{userId}|{groupId}], rule?, quorum?, when? }: up to 10 seats per stage and 30 across the whole chain; `rule` and `quorum` work exactly as they do for a panel, but PER STAGE; `when` is an expression (like a condition step\'s `expr`, e.g. "steps.invoice.output.amount > 5000") evaluated ONCE when the request is raised — a stage whose condition is not met is skipped and recorded as skipped. Only the current stage\'s people are asked, and only when their turn arrives; one reject at ANY stage declines the whole request immediately. Name stages after who decides ("Team lead", "Finance", "Director sign-off") and use `description` to say what that stage is checking. EXAMPLE: [{name:"Team lead",approvers:[{userId:"u1"}],rule:"first"},{name:"Finance",approvers:[{groupId:"g_fin"}],rule:"first"},{name:"Director",approvers:[{userId:"u9"}],rule:"first",when:"steps.invoice.output.amount > 5000"}].', items: { type: 'object' } },
                    remindAfterHours: { type: 'integer', description: 'Nudge the approver again this many hours after the request (1..720). Must be earlier than expiresInHours or it never fires. Omit for no reminder.' },
                    escalateTo: { type: 'object', description: 'Who takes over when nobody decides: { userId } or { groupId } in the owner\'s org. Escalation WIDENS the decider set — the original approver keeps their rights. Requires escalateAfterHours.' },
                    escalateAfterHours: { type: 'integer', description: 'Hours before the escalation target gains decide rights (1..720, earlier than expiresInHours). Requires escalateTo.' },
                    label: { type: 'string' },
                },
                required: ['prompt'],
            },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_3 };
