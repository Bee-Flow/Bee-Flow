/**
 * Builder tools — the LEAN projection of the tool schemas for the small band.
 *
 * The full schemas in ./schemas.js are written for frontier models and for
 * the MCP surface (automation/mcpBuilder.js ships them verbatim): every rule,
 * every alias, every edge case, in prose. Measured 2026-09-17 on the demo box
 * (Gemma 4 26B-A4B, 3.8B active, llama.cpp): the core menu was 89 kB ≈ 20k
 * tokens — three quarters of a 27k-token first-round prefix — and
 * builder_propose_trigger alone was 4.6k tokens, a 12.5 kB trigger catalogue
 * the model re-read on every session. The Gemma chat template renders only
 * description|type|enum|items|properties|required|nullable, so everything
 * else in there was noise for that band, and a small model reads noise as
 * instruction: it put `scope` on steps that have no flowlet and reached for
 * the batch tools it was told about instead of the one it needed.
 *
 * This module answers with a per-tool diet: shorter descriptions that keep
 * the ONE example beside each decision, the shared params stated once, the
 * long-tail properties gone, and four tools dropped from the menu outright.
 * It is band-owned (builderModelProfiles.js `schemaVariant`), never a
 * per-model override: the lean prompt (builderPrompt.js) and this projection
 * are written together and teach the same menu.
 *
 * Contract:
 *   - `full` is the identity: the SAME array and object references come back,
 *     so the cloud bands keep the bytes their prompt caches hold.
 *   - `lean` never mutates TOOL_SCHEMAS — every tool is structuredClone'd first.
 *   - Every `required` list of the source schema survives the projection.
 *   - Schema KEYWORDS Gemma cannot render (minItems, maxItems, default,
 *     format) are stripped at schema nodes; property NAMES never are.
 *   - `additionalProperties:false` on builder_add_steps.steps.items stays: it
 *     is what keeps step fields inside `spec` under grammar-constrained
 *     decoding (measured 2/12 → 0/12 corrupt keys, see schemas.js).
 */

'use strict';

// Tools the small menu does without (owner decision 2026-09-17). Each one
// stays in CORE_TOOL_NAMES so the menu tests, the MCP surface and the
// leaked-call recovery keep ONE list; this is the only place they leave it.
//   builder_update_steps     all-or-nothing batch. Gemma emits several calls
//                            per reply anyway, so N builder_update_step calls
//                            keep the round count AND get a per-call repair
//                            ladder instead of one refusal for the whole batch.
//   builder_add_loop         no loop container on this menu — per-item work is
//                            forEach on the step, chained through
//                            steps.<prev>.output.results (the lean prompt).
//   builder_replace_step     exists to edit loop bodies and change a step's
//                            type; without loops the first use is gone and the
//                            second is remove + add, which the prompt allows
//                            for restructuring.
//   builder_wire_error_branch  branch:"error" on a NEW step covers "if X
//                            fails, do Y"; wiring two EXISTING steps is a rare
//                            edit for a band that builds in one batch.
const DROP_TOOLS_SMALL = Object.freeze([
    'builder_update_steps',
    'builder_add_loop',
    'builder_replace_step',
    'builder_wire_error_branch',
]);

// Step types whose single-step tool is on the lean menu — the batch enum
// may name nothing the model could not also build one at a time, so a
// dry-run repair of that step type always has a tool.
const LEAN_BATCH_TYPES = Object.freeze([
    'integration_action', 'ai_step', 'data_extraction', 'condition', 'notification',
    'http_request', 'datatable', 'approval', 'array_op',
]);

// JSON-schema keywords the Gemma 4 template does not render (only
// description|type|enum|items|properties|required|nullable reach the model).
// Stripped at SCHEMA NODES — a property called `maxItems` (form.fields[])
// or `format` (generate_document) is a name, not a keyword, and is left
// alone by the walk below.
const UNRENDERED_KEYWORDS = Object.freeze(['minItems', 'maxItems', 'default', 'format']);

// Shared params, stated once. builderTools.js injects `scope` and `forEach`
// into every graph tool and widens every `branch` enum with 'error' for the
// FULL schema; the lean variant overwrites those texts (and drops `scope` —
// no flowlets on this menu — and `caseName` — no switch). A property listed
// with `null` is removed.
const SHARED_PARAMS = Object.freeze({
    scope: null,
    caseName: null,
    afterStepId: { description: 'Anchor step id. Default: the last step (in a batch: the previous entry).' },
    splice: { description: 'true: insert BETWEEN afterStepId and its successor. Default false: add beside it.' },
    branch: {
        enum: ['then', 'else', 'error'],
        description: 'When afterStepId is a condition: "then" | "else". "error" = run only when afterStepId fails.',
    },
    label: { description: 'Short canvas label.' },
    forEach: {
        type: 'object',
        description: 'Run this step once per item of an upstream array: {overRef:"steps.<id>.output.<array>", itemVar:"x"}; bind the item as loop.x (see "Placing steps").',
        properties: {
            overRef: { type: 'string' },
            itemVar: { type: 'string' },
            maxIterations: { type: 'number' },
        },
        required: ['overRef'],
    },
});

// The one sentence on builder_set_metadata is the same on BOTH variants (the
// full text lives in schemas.js); it is repeated here so the projection is
// self-contained and a test can pin the two against each other.
const SET_METADATA_DESCRIPTION = 'Name the automation. REQUIRED once per new draft — in your FIRST reply, bundled with the trigger call: title ≤ 60 chars, in the user\'s language, saying what the automation does ("Facturen uit /Invoices naar tabel Facturen"); description = one sentence. When the request states a title, use it verbatim. Call again to rename.';

/**
 * Per-tool description and property overrides. `props` entries merge into
 * the cloned property (so `type`, `items`, `enum` survive unless overridden);
 * `null` drops the property. Every text is verified against the real schema
 * and the real apply* implementation: the example in each one is a call the
 * builders accept (fewShotExamples.replay.test.js replays the few-shots that
 * copy them).
 */
const LEAN = Object.freeze({
    builder_propose_trigger: {
        description: 'Set the trigger. The FIRST call of a new draft; calling it again REPLACES the trigger. kind: manual (the user clicks Run) | schedule (cron + tz) | form (form.fields → trigger.output.<name>) | webhook (trigger.output = the POSTed JSON) | app_event (appProvider + appEvent + optional filter — the events, their filter keys and payload fields are listed under "## Triggers" in the system prompt). Bind the payload as trigger.output.<field>; never add a search step for data already in the payload.',
        props: {
            kind: { enum: ['schedule', 'manual', 'webhook', 'form', 'app_event'] },
            cron: { description: '5-field cron, e.g. "0 9 * * 1-5" (schedule only).' },
            tz: { description: 'IANA timezone, default Europe/Amsterdam.' },
            appProvider: { description: 'app_event: provider id from ## Triggers.' },
            appEvent: { description: 'app_event: event id from ## Triggers.' },
            filter: { description: 'app_event: only the filter keys ## Triggers lists for that event. Omitted = every event.' },
            toolName: null,
            parametersSchema: null,
            params: null,
        },
    },
    builder_add_action: {
        description: 'Append one integration action. tool = the exact catalog name (inspect it first with builder_inspect_tool). inputs = {<param>: binding} — every value a binding object (Binding rules). EXAMPLE: {tool:"gmail_search",inputs:{query:{kind:"literal",value:"is:unread"}},label:"Find mail"}.',
        props: {
            tool: { description: 'Exact tool name from the catalog.' },
            inputs: { description: 'Map of input name → binding object.' },
        },
    },
    builder_add_ai_step: {
        description: 'Append an AI step for judgement or writing (classify, summarise, draft a reply) — NOT for extraction (use data_extraction). systemPrompt = role/tone; prompt = the task, naming the inputs; inputs = {name: binding}; outputSchema = the JSON shape of the answer so later steps can bind steps.<id>.output.<field>. EXAMPLE: {prompt:"Summarise the emails in `emails` as 5 bullets.",inputs:{emails:{kind:"ref",path:"steps.s1.output.results"}},outputSchema:{digest:"string"}}.',
        props: {
            systemPrompt: { description: 'Optional role/tone/output style ("You are a meticulous bookkeeper. Answer in Dutch.").' },
            prompt: { description: 'The task for this run, naming the inputs.' },
            inputs: { description: 'Map of name → binding object; the prompt refers to them by name.' },
            outputSchema: { description: 'The JSON shape of the answer, e.g. {digest:"string"}.' },
            modelTier: { description: 'One of the tiers in the "This turn" note, or omit.' },
            allowTools: { description: 'true lets the step call the user\'s tools itself. Rare.' },
            tools: null,
            useMemory: null,
            agentPermissions: null,
            disabledAgentSkillIds: null,
            agentId: { description: 'Only an id the user showed you; never invent one.' },
            skillIds: { description: 'Only ids the user showed you; never invent one.' },
            knowledgeBaseIds: { description: 'Only ids the user showed you; never invent one.' },
        },
    },
    builder_add_condition: {
        description: 'Append an if/else that decides ONCE for the whole run. expr reads trigger/steps/loop values: comparisons, && / ||, contains(), equals(), startsWith(), isEmpty(), len(). Text helpers ignore upper/lower case: never lower()/upper(). EXAMPLE: contains(trigger.output.subject, "invoice"). It does not filter a list: to keep the matching items use builder_add_array_op op:"filter" and read its output.items. Grow the branches by adding steps with afterStepId = this id and branch:"then" | "else".',
        props: {
            expr: { description: 'The expression; true takes the "then" branch.' },
            thenStepId: { description: 'Wire an EXISTING step onto the "then" branch.' },
            elseStepId: { description: 'Wire an EXISTING step onto the "else" branch.' },
        },
    },
    builder_add_notification: {
        description: 'Append an in-app notification. title/body are TEMPLATE strings: {{steps.<id>.output.<field>}}. For e-mail use builder_add_action with gmail_compose instead.',
        props: {
            title: { description: 'Template string.' },
            body: { description: 'Template string.' },
            channels: { description: 'Omit for the in-app channel.' },
        },
    },
    builder_add_http_request: {
        description: 'Append a plain HTTP call to any URL (incoming webhooks, REST APIs). url/headers/body are template strings ({{…}}). Output: {status, ok, body (text), data (the body parsed when JSON)} — bind lists to data. Never put secrets in headers: pass authConnectionId (a saved credential id the user gave you).',
        props: {
            url: { description: 'Full URL, template string.' },
            method: { description: 'Default GET; POST for most webhooks.' },
            headers: { description: 'Header name → template string, e.g. {"Content-Type":"application/json"}. No secrets.' },
            body: { description: 'Request body (raw text or JSON), template string. POST/PUT/PATCH only.' },
            timeoutMs: { description: '1000..60000, default 10000.' },
            parseResponse: { description: 'How to fill output.data: auto (JSON content-type), never, always.' },
            blockPrivateTargets: { description: 'Default true. false ONLY for an internal address the user explicitly asked for.' },
            authConnectionId: { description: 'Id of a saved HTTP credential the user supplied; never invent one.' },
            askOnce: null,
            cacheInto: null,
        },
    },
    builder_add_data_extraction: {
        description: 'Append a step that reads NAMED, TYPED fields out of text (an invoice, a mail body, a PDF\'s text). source = ONE binding to the text ({kind:"ref",path:"steps.<id>.output.content"}; inside a forEach: loop.<v>.output.content). fields = the output shape: [{name (snake_case; becomes steps.<id>.output.<name>), type: string|number|date|boolean, description, required?}]. No prompt, no inputs, no outputSchema, no modelTier — it runs on the admin\'s extraction model. Numbers come back as real numbers, dates as YYYY-MM-DD.',
        props: {
            source: { description: 'ONE binding to the text: {kind:"ref",path:"…"}. Never a literal.' },
            fields: {
                description: 'The output shape, in order.',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: 'snake_case, unique in the step; becomes the output key.' },
                        type: { type: 'string', enum: ['string', 'number', 'boolean', 'date'] },
                        description: { type: 'string', description: 'What to look for, one line.' },
                        required: { type: 'boolean', description: 'true: the step FAILS when the text lacks it (default false → null).' },
                    },
                    required: ['name', 'type'],
                },
            },
            instructions: { description: 'Optional one-line guidance (units, language, which of two dates).' },
        },
    },
    builder_add_datatable: {
        description: 'Append a step that reads or writes ROWS of a datatable (rows outlive the run). op: add_row (values) | save_row (values + matchColumn, which must also be in values) | find_rows (where?, sort?, limit? → {rows, returned, hasMore}) | count_rows (→ {count}) | update_rows (values + where) | delete_rows (where). datatableId AND datatableKey EXACTLY as the "Datatables you may use" block shows them; a missing table is created first with builder_create_datatable. values keys are the column KEYS; each value is a binding object. where = [{field, op: eq|neq|gt|gte|lt|lte|contains|startsWith|in|between|isNull|isNotNull, value}]. EXAMPLE: {op:"add_row",datatableId:"tbl_x",datatableKey:"facturen",values:{datum:{kind:"ref",path:"loop.x.output.datum"}},forEach:{overRef:"steps.ex1.output.results",itemVar:"x"}}.',
        props: {
            datatableId: { description: 'From the Datatables block, or what builder_create_datatable returned.' },
            datatableKey: { description: 'That table\'s key, exactly as shown beside the id.' },
            where: {
                description: 'Conditions [{field, op, value}]; in/between take an array.',
                items: {
                    type: 'object',
                    properties: {
                        field: { type: 'string' },
                        op: { type: 'string' },
                        value: { description: 'A literal or a {{…}} template.' },
                    },
                    required: ['field', 'op'],
                },
            },
            match: { description: '"all" (default) or "any".' },
            values: { description: 'Column key → binding object.' },
            matchColumn: { description: 'save_row only: the column that decides update vs insert; must also be in values.' },
            sort: {
                description: 'find_rows only: [{field, dir:"asc"|"desc"}] — first entry only.',
            },
            limit: { description: 'find_rows only: 1-1000, default 50.' },
            cursor: null,
        },
    },
    builder_create_datatable: {
        description: 'Create a NEW datatable now, at design time (not a step) — only when the "Datatables you may use" block has no fitting table. fields = the columns [{name, type: text|number|date|datetime|bool|select (+options)|multiselect|file}]; keys are derived from names ("Excl. btw" → excl_btw). Returns datatableId, datatableKey and the column keys the add_row step uses. The same name twice returns the existing table.',
        props: {
            name: { description: 'The table\'s title as the person sees it, e.g. "Facturen".' },
            description: { description: 'One sentence: what the rows are.' },
            fields: { description: 'The columns: [{name, type, options? (select), required?}].' },
        },
    },
    builder_add_approval: {
        description: 'Append a step that PAUSES the run until a person approves. prompt = what the approver reads (template — quote the thing: {{steps.x.output.total}}). assignee = {userId} or {groupId}; omit = the owner decides. On approve the run continues (steps.<id>.output.approved/by/reason); on reject it ENDS — never wire a rejected branch. Never with forEach.',
        props: {
            prompt: { description: 'The question the approver sees; template string.' },
            expiresInHours: { description: '0..720; 0 = no deadline; default 168.' },
            assignee: { description: '{userId:"…"} or {groupId:"…"} in the owner\'s org. Omit = the owner.' },
            details: { description: 'Optional markdown context, template string.' },
            attachments: { description: 'Up to 5 of {binding:"{{steps.doc.output.fileId}}", label?}.' },
            fields: { description: 'Up to 20 extra questions [{name, label, type, required?}]; answers bind as steps.<id>.output.answers.<name>.' },
            approvers: null,
            rule: null,
            quorum: null,
            finalApprover: null,
            stages: null,
            remindAfterHours: null,
            escalateTo: null,
            escalateAfterHours: null,
        },
    },
    builder_add_array_op: {
        description: 'Append a list operation over an upstream array (arrayRef is a path string, not a binding). op: filter (expr over `item`) | limit (count, mode) | dedupe (keyField?) | aggregate (field → {values}) | summarize (field + fn sum|count|avg|min|max → {result}). Output {items, count}. filter rules: contains(item.subject, "invoice"), equals(item.status, "open"), item.amount > 1000, anyOf(item.attachments[*].filename, "endsWith", ".pdf"); never lower()/upper(). Drop failed forEach items with {op:"filter",arrayRef:"steps.<prev>.output.results",expr:"equals(item.status, \\"success\\")"}.',
        props: {
            arrayRef: { description: 'Path to the upstream array, e.g. "steps.s1.output.results".' },
            expr: { description: 'filter only: expression over item.<field>.' },
            count: { description: 'limit only.' },
            mode: { description: 'limit only: default "first".' },
            keyField: { description: 'dedupe only: field to dedupe by.' },
            field: { description: 'aggregate/summarize: field name on each item.' },
            fn: { description: 'summarize only.' },
        },
    },
    builder_add_steps: {
        description: 'Append SEVERAL steps in ONE call — the default way to build. Entries apply in order; each is {tempId, type, spec}. Later entries reference earlier ones as steps.$<tempId>.output.<field> in ref paths, templates and forEach.overRef, and as "$<tempId>" in afterStepId/thenStepId/elseStepId. An entry without afterStepId chains after the previous entry. If entry i is refused, the entries before it STAY built and the error names the index: resend from that index only.',
        // The nested edits (tempId text, the type enum, the spec text) are
        // applied by projectAddSteps below — they sit two levels down.
    },
    builder_update_step: {
        description: 'Change an EXISTING step in place — keeps its id and wiring. patch = only the fields to change, in the shape the add tool takes (a refusal lists the allowed fields). Move a step with patch:{afterStepId, branch?}. inputs/values merge per key (null deletes a key; inputsMode:"replace" overwrites). Dry-run repair: ONE builder_update_step per failing step, all in the SAME reply as the next builder_request_dry_run.',
        props: {
            stepId: { description: 'The step\'s real id (from the echo or the draft state).' },
            patch: { description: 'Only the fields to change, in the add tool\'s shape: e.g. {inputs:{path:{kind:"ref",path:"loop.f.path"}}}, {source:{kind:"ref",path:"loop.r.output.content"}}, {values:{datum:{kind:"ref",path:"loop.x.output.datum"}}}, {afterStepId:"<id>",branch:"else"}. Never type or id.' },
            inputsMode: { description: '"merge" (default, per key) or "replace" (whole map).' },
        },
    },
    builder_remove_step: {
        description: 'Remove a step by id; its neighbours are re-joined. Never remove-and-re-add to edit or move a step — use builder_update_step.',
        props: {
            stepId: { description: 'The step\'s real id.' },
            reconnect: { description: 'Default true: bridge predecessors to successors.' },
        },
    },
    builder_set_plan: {
        description: 'Your checklist, shown live to the user. First reply of a build: {todos:[{text}]}; every later reply that finishes an item: {markDone:[indices]} bundled with the build call. Never as the only call in a reply. Returns the list with each item\'s index and `next`.',
        props: {
            todos: { description: 'The full ordered checklist (first reply, or a restructure).' },
            markDone: { description: '0-based indices to flip done.' },
        },
    },
    builder_inspect_tool: {
        description: 'Look up the EXACT input names and output shape of catalog actions before binding them: {tools:["gmail_search","gmail_compose"]} — every tool you will use, in ONE call. Returns per tool: inputs, requiredInputs, shape.',
        props: {
            tools: { description: 'Exact catalog names, all in one call.' },
            tool: null,
        },
    },
    builder_summarise: {
        description: 'Plain-English summary of the draft for the user. Call it in the reply that also dry-runs.',
    },
    builder_request_dry_run: {
        description: 'Run the draft once in test mode. Call it ONCE, when every step exists. Side-effect steps are simulated. Returns ok + note, and per step its status and a _hint with the real output keys and shape — trust those; only a failed step carries its error and input, a forEach reports its failed items, a step that produced nothing says empty:true. ok:true = nothing to fix: finalize. Otherwise fix each failed step with builder_update_step and dry-run again in the same reply.',
        props: {
            triggerPayload: { description: 'Optional sample payload for an app_event or webhook trigger.' },
            triggerStepId: null,
        },
    },
    builder_finalize: {
        description: 'Save the automation as finished (still inactive until the user activates it). Only after a clean dry run, and only when builder_set_metadata has named it.',
    },
    builder_set_metadata: {
        description: SET_METADATA_DESCRIPTION,
        props: {
            title: { description: '≤ 60 chars, the user\'s language, what the automation does.' },
            description: { description: 'One sentence.' },
        },
    },
});

/** Merge an override into a cloned property; `null` removes it. */
function applyPropOverrides(properties, overrides) {
    if (!properties || !overrides) return;
    for (const [name, over] of Object.entries(overrides)) {
        if (!(name in properties)) continue;
        if (over === null) { delete properties[name]; continue; }
        const merged = { ...properties[name], ...over };
        properties[name] = merged;
    }
}

/** builder_propose_trigger.form — the nested trims the table above cannot express. */
function projectTriggerForm(properties) {
    const form = properties && properties.form;
    if (!form || !form.properties) return;
    form.description = 'kind=form: the public page. fields[].name is what you bind as trigger.output.<name>.';
    const fields = form.properties.fields;
    const item = fields && fields.items && fields.items.properties;
    if (!item) return;
    // The app_pick extras (multiple / maxItems / withText) are for a form
    // that picks several records — off the small band's beaten path, and
    // `maxItems` as a NAME here would read like the keyword the walk strips.
    delete item.multiple;
    delete item.maxItems;
    delete item.withText;
    if (item.options) item.options.description = 'select only.';
    if (item.accept) item.accept.description = 'file only: MIME allowlist, e.g. "application/pdf".';
    if (item.maxSizeMb) item.maxSizeMb.description = 'file only: 1–25.';
    if (item.source) {
        // Keep the real source list — it is derived from the registry the
        // submit route validates against (schemas.js), not typed out here.
        const m = /One of: ([^.]+)\./.exec(String(item.source.description || ''));
        item.source.description = `app_pick only: one of ${m ? m[1] : 'the sources the full schema lists'}.`;
    }
}

/** builder_add_steps.steps.items — tempId text, the type enum, the spec text. */
function projectAddSteps(properties) {
    const items = properties && properties.steps && properties.steps.items;
    if (!items || !items.properties) return;
    if (items.properties.tempId) {
        items.properties.tempId.description = 'Handle for this step, fresh per step ([A-Za-z][A-Za-z0-9_]*). Later entries use steps.$<tempId>.output.<field> or "$<tempId>" — the $ is required.';
    }
    if (items.properties.type) {
        items.properties.type.enum = [...LEAN_BATCH_TYPES];
    }
    if (items.properties.spec) {
        items.properties.spec.description = 'EXACTLY the fields of the matching builder_add_<type> tool (tool+inputs · prompt+inputs+outputSchema · source+fields · op+datatableId+datatableKey+values · expr · title+body · url+method+body · op+arrayRef · prompt+assignee) plus the shared ones: afterStepId, branch ("then"|"else"|"error"), label, forEach:{overRef,itemVar}. Put EVERY step field inside spec, never beside it. Per-item work is forEach on the step; chain the next entry\'s forEach over steps.$<prev>.output.results and bind loop.<v>.output.<field>. Prefer {kind:"ref"} bindings over {{templates}} inside a batch.';
    }
}

/**
 * Strip the keywords Gemma cannot render, at schema nodes only. A `properties`
 * map is walked by VALUE — its keys are property names and are never touched.
 */
function stripUnrenderedKeywords(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const n of node) stripUnrenderedKeywords(n); return; }
    for (const k of UNRENDERED_KEYWORDS) delete node[k];
    if (node.properties && typeof node.properties === 'object') {
        for (const child of Object.values(node.properties)) stripUnrenderedKeywords(child);
    }
    if (node.items) stripUnrenderedKeywords(node.items);
    if (node.additionalProperties && typeof node.additionalProperties === 'object') stripUnrenderedKeywords(node.additionalProperties);
    for (const k of ['anyOf', 'oneOf', 'allOf']) if (Array.isArray(node[k])) stripUnrenderedKeywords(node[k]);
}

/** One cloned tool → its lean form. */
function projectOne(tool) {
    const fn = tool.function;
    const params = fn.parameters || { type: 'object', properties: {} };
    const props = params.properties || {};
    // 1. Shared params, stated once (scope/caseName gone).
    applyPropOverrides(props, SHARED_PARAMS);
    // 2. The tool's own diet.
    const lean = LEAN[fn.name];
    if (lean) {
        if (lean.description) fn.description = lean.description;
        if (lean.props) applyPropOverrides(props, lean.props);
    }
    if (fn.name === 'builder_propose_trigger') projectTriggerForm(props);
    if (fn.name === 'builder_add_steps') projectAddSteps(props);
    // 3. What the template cannot render anyway.
    stripUnrenderedKeywords(params);
    return tool;
}

/**
 * @param {Array} tools   OpenAI-shape tool definitions (the menu after the
 *                        feature-flag and toolset filters in chatStream.js)
 * @param {{variant?: 'full'|'lean'}} opts
 * @returns {Array}       `full`: the same array; `lean`: new objects
 */
function projectToolSchemas(tools, { variant = 'full' } = {}) {
    if (variant !== 'lean') return tools;
    if (!Array.isArray(tools)) return tools;
    return tools
        .filter(t => t && t.function && !DROP_TOOLS_SMALL.includes(t.function.name))
        .map(t => projectOne(structuredClone(t)));
}

module.exports = {
    projectToolSchemas,
    DROP_TOOLS_SMALL,
    LEAN_BATCH_TYPES,
    SET_METADATA_DESCRIPTION,
    UNRENDERED_KEYWORDS,
    // For tests: the walk must never touch a property NAME.
    _stripUnrenderedKeywords: stripUnrenderedKeywords,
};
