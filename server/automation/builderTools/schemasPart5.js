// @typecheck strict
// Part 5 of the TOOL_SCHEMAS array (split out of schemas.js; order is preserved there).

const { BATCH_STEP_TYPES, REPLACEABLE_STEP_TYPES } = require('./stepTypeTable');
const { BINDING_HINT } = require('./schemaFragments');

/** @type {Array<{ type: string, function: { name: string, description: string, parameters: object } }>} */
const TOOL_SCHEMAS_PART_5 = [
    {
        type: 'function',
        function: {
            name: 'builder_wire_error_branch',
            description: 'Wire an on-error branch between two EXISTING steps: adds an edge {from, to, label:"on_error"} so that when fromStepId fails (after exhausting its per-step retries), the run continues at toStepId instead of failing. Inside the branch, bind the failure via steps.<fromStepId>.error.message / .errorClass. A run whose failures are all handled this way still reports success ("N step error(s) handled"). Only failure-capable steps may have an error branch: integration_action, ai_step, data_extraction, code, http_request, generate_document, fill_document, presentation, datatable, call_layer, loop, parallel, notification, wait — NOT trigger/condition/switch/approval/form_page/stop_error/return_to_app (the last two END the run, so the branch could never be reached). To create a NEW step directly on the error branch, instead call builder_add_action / builder_add_ai_step / etc. with afterStepId=<failing step> and branch:"error".',
            parameters: {
                type: 'object',
                properties: {
                    fromStepId: { type: 'string', description: 'The step whose failure should be handled (must already exist).' },
                    toStepId: { type: 'string', description: 'The existing step the run continues at when fromStepId fails.' },
                },
                required: ['fromStepId', 'toStepId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_trigger',
            description: `Add an ADDITIONAL trigger (entry point) to the automation — beside the primary one set by builder_propose_trigger. NEVER call builder_propose_trigger a second time to get a second trigger: that REPLACES the primary. Kinds: app_event (appProvider + appEvent + optional filter — same catalog as builder_propose_trigger), schedule (cron + tz), webhook. manual / form / agent_call / app_trigger can only be the primary. Returns the new trigger id: wire its first step with afterStepId:"<that id>" (an omitted afterStepId chains after the LAST step, never after a new trigger). Each trigger is its own root; two roots may converge on one step, and that step can branch on trigger.kind / trigger.event / trigger.id. A schedule run has no payload — start it with a datetime step (op:"now"). Test one root with builder_request_dry_run({triggerStepId}). EXAMPLES: {kind:"app_event",appProvider:"google-calendar",appEvent:"event.upcoming",filter:{leadMinutes:30},label:"Meeting prep"} · {kind:"schedule",cron:"0 7 * * 1-5",tz:"Europe/Amsterdam",label:"Morning briefing"}.`,
            parameters: {
                type: 'object',
                properties: {
                    kind: { type: 'string', enum: ['app_event', 'schedule', 'webhook'], description: 'Trigger kind. Only these may be additional triggers.' },
                    appProvider: { type: 'string', description: 'When kind=app_event: provider id (gmail, google-calendar, google-drive, approvals, nextcloud, …).' },
                    appEvent: { type: 'string', description: 'When kind=app_event: event id (mail.new, label.added, event.upcoming, approval.decided, …).' },
                    filter: { type: 'object', description: 'When kind=app_event: optional filter object, same shape as builder_propose_trigger.' },
                    cron: { type: 'string', description: 'When kind=schedule: standard 5-field cron, e.g. "0 7 * * 1-5".' },
                    tz: { type: 'string', description: 'When kind=schedule: IANA timezone (default Europe/Amsterdam).' },
                    label: { type: 'string', description: 'Short label for the canvas, e.g. "Daily briefing". Defaults to provider · event / the cron.' },
                },
                required: ['kind'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_trigger',
            description: 'Edit a trigger IN PLACE (the primary or an additional one) — its label, an app_event\'s appProvider/appEvent/filter, a schedule\'s cron/tz, an agent_call\'s toolName/description/params (or parametersSchema), a form\'s `form` (title, fields, …) or an app_trigger\'s params. Keeps the id, the label, the position and every edge wired out of it; only the keys you pass change. A declared input is bound in steps as trigger.output.<name>. A trigger cannot change kind in place: remove it (builder_remove_step with the trigger id) and add a new one, or use builder_propose_trigger for the primary.',
            parameters: {
                type: 'object',
                properties: {
                    triggerId: { type: 'string', description: 'The trigger id ("trg" for the primary, or an id returned by builder_add_trigger).' },
                    patch: { type: 'object', description: 'Fields to change: label; appProvider, appEvent, filter (app_event); cron, tz (schedule); toolName, description, params or parametersSchema (agent_call; params REPLACES the whole argument list, so send every argument); form (form: any of title, description, submitLabel, successMessage, collect, fields — fields REPLACES the whole list); params (app_trigger). Other keys are ignored and reported.' },
                },
                required: ['triggerId', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_remove_step',
            description: 'Remove a step from the draft by id. By default (reconnect:true) the step\'s predecessors are bridged to its successors so the flow stays connected (deleting a step mid-chain keeps the chain wired, preserving branch labels). Pass reconnect:false to just sever the step and drop its incident edges. To CHANGE a step rather than delete it, use builder_update_step / builder_replace_step instead — recreating mints a new id and breaks downstream references. Also accepts the id of an ADDITIONAL trigger: the trigger and its outgoing edges are removed and any step left without an incoming edge is reported as orphaned. The primary trigger cannot be removed.',
            parameters: { type: 'object', properties: { stepId: { type: 'string' }, reconnect: { type: 'boolean', description: 'Default true: bridge predecessors→successors after removal so the flow stays connected. false: just drop the step and its edges.' } }, required: ['stepId'] },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_step',
            description: `Update an EXISTING step in place by id WITHOUT removing and re-adding it — keeps the step id and ALL wiring (incoming/outgoing edges, branch labels, forEach), so downstream steps.<id>.output.* references keep working. ALWAYS prefer this over remove+add when editing a step. It also MOVES a step: patch {afterStepId:"<id>", branch?:"then"|"else"|"error", caseName?} on the step to move — it is detached from where it is (its neighbours are re-joined) and inserted after the anchor, KEEPING its id, so downstream refs survive. That is how you put a step on a condition's other branch or re-order a chain; never remove-and-re-add for that. On a condition, patch {thenStepId|elseStepId:"<existing step id>"} to wire an existing step onto that branch. Patch is partial: only the fields you pass change. A step's TYPE changes through builder_replace_step; a patch with type:"<newType>" (or tool:"<step type>" on an action) is applied as one, and says so. inputs/fields MERGE key-by-key by default (pass a key value of null to delete just that key; pass inputsMode:"replace" to overwrite the whole map). ${BINDING_HINT} EXAMPLE — retarget an AI step's model and tweak its prompt: {stepId:"ai_1a2b3c",patch:{modelTier:"thinking",prompt:"Summarise concisely in Dutch."}}.`,
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string', description: 'Id of the step to update (root flow, a flowlet via scope, or a loop-body step).' },
                    patch: { type: 'object', description: 'Fields to change. ANY step: afterStepId (+ branch/caseName) MOVES it — same id, chain re-joined where it left; condition: thenStepId/elseStepId wire an EXISTING step onto that branch. Other allowed keys depend on the step type (ai_step: prompt, systemPrompt, inputs, outputSchema, modelTier, allowTools, tools, knowledgeBaseIds, useMemory, skillIds, agentPermissions, disabledAgentSkillIds (the full list), temperature, enumFrom, checks, fallback, askOnce (as on builder_add_ai_step; each replaced wholesale, null clears), label, forEach, and agentId ONLY on a step that has none yet — pointing a step at a DIFFERENT agent goes through builder_replace_step, so the permission check runs on it (the one exception is a step INSIDE A LOOP BODY, which builder_replace_step cannot reach at all: patch it here and the same save-time check still runs); data_extraction: source, fields (replaced wholesale — send the full list), instructions, label, forEach; integration_action: tool, inputs, label, forEach; condition: expr, label; switch: expr, cases, defaultBranch, label; code: code (keep its JSDoc @param lines in step with the inputs it reads), inputs, outputSchema, allowedTools, limits, label, forEach; set: fields, arrayRef, operations, maxItems, label, forEach — arrayRef: null exits list mode, operations replace wholesale (null clears); notification: title, body, channels, label, forEach; http_request: url, method, headers, body, query (see builder_add_http_request), timeoutMs, blockPrivateTargets, parseResponse, label, forEach, askOnce, cacheInto; datatable: op, where, values, matchColumn, sort, limit, label, forEach, datatableKey, and datatableId ONLY on a step that has none yet (repointing a step that already names a table goes through builder_replace_step); knowledge_write: content, title, sourceUri, nearDuplicateStrategy, label, forEach, and knowledgeBaseId ONLY on a step that has none yet (repointing a write at a different base goes through builder_replace_step, so the save-time permission check runs on it); loop: overRef, itemVar, maxIterations, label; call_layer: inputs, label; datetime/wait/stop_error/filter/limit/dedupe/aggregate/summarize: their own fields + label; approval: prompt, approval as {expiresInHours (0..720, 0 = no deadline), assignee {userId}|{groupId}, details, attachments, fields}, label — approval steps do NOT accept forEach). Do NOT pass `id`. A type change carries the fields of the new type: patch {type:"datatable", op, datatableId, datatableKey, values}.' },
                    inputsMode: { type: 'string', enum: ['merge', 'replace'], description: 'How to apply patch.inputs / patch.fields. Default "merge" (per-key; value null deletes that key). "replace" overwrites the whole map.' },
                },
                required: ['stepId', 'patch'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_update_steps',
            description: `Apply several step patches in ONE call — the way to fix every dry-run error, or put forEach on two steps, in a single round instead of one builder_update_step per step. Each entry is exactly a builder_update_step call: {stepId, patch, inputsMode?}. All-or-nothing: if any patch fails validation, NONE are applied. ${BINDING_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    updates: {
                        type: 'array',
                        description: 'List of patches to apply, each {stepId, patch, inputsMode?}.',
                        items: { type: 'object', properties: { stepId: { type: 'string' }, patch: { type: 'object', description: 'Same rules as builder_update_step.patch: partial; per-type allowed keys; every input value a {kind,...} binding object; afterStepId (+branch/caseName) MOVES the step keeping its id; on a condition thenStepId/elseStepId wire an existing step onto that branch.' }, inputsMode: { type: 'string', enum: ['merge', 'replace'] } }, required: ['stepId', 'patch'], additionalProperties: false },
                    },
                },
                required: ['updates'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_add_steps',
            description: `Append SEVERAL steps in ONE call — the fast path for building a flow; strongly preferred over a sequence of single builder_add_* calls once you know every binding. Entries are applied in order. Give each step a short tempId (e.g. "search") and reference it from LATER entries: in any ref path / {{template}} / expr / forEach.overRef / arrayRef write steps.$search.output.<field>, and for wiring fields (afterStepId / thenStepId / elseStepId / nextStepIds values) write "$search" — the server rewrites every $tempId to the real minted id and returns the mapping. An entry without afterStepId chains after the PREVIOUS entry (first entry: after the current last step). Entries apply in order; if entry i fails, the entries before it STAY built and the error tells you which index failed and what to resend. Resend only from that index — built entries are never added twice. ${BINDING_HINT}`,
            parameters: {
                type: 'object',
                properties: {
                    steps: {
                        type: 'array',
                        maxItems: 20,
                        description: 'Ordered list of steps to append.',
                        items: {
                            type: 'object',
                            // Closed on purpose: llama.cpp compiles this schema
                            // into the decoding grammar, so an open entry lets
                            // the model put step fields BESIDE spec — which it
                            // did on every entry of every live build — and, at
                            // temperature, lets it wander into a corrupt key
                            // (`"{spec": …`, `"{kind": …`) that no longer parses
                            // as the call it meant. Measured 2026-09-16 with the
                            // real menu, 12 runs: 2 corrupt keys with the entry
                            // open, 0 with it closed. `spec` stays free-form, so
                            // nothing becomes inexpressible — only misplaceable.
                            // The server still lifts a stray field into spec for
                            // providers that do not enforce the schema.
                            additionalProperties: false,
                            properties: {
                                tempId: { type: 'string', description: 'Handle for THIS TURN ([A-Za-z][A-Za-z0-9_]*): a handle names ONE step for the whole turn — pick a fresh one for every new step, also in a later builder_add_steps call (re-using a handle for a different step is refused). Reference from later entries as steps.$<tempId>.output.<field> or "$<tempId>" in wiring fields — the $ is REQUIRED; steps.<tempId> without it is stored verbatim and dangles. After a partial batch you may keep using steps.$<tempId> for entries that were built; across turns use the real id.' },
                                type: { type: 'string', enum: [...BATCH_STEP_TYPES] },
                                spec: { type: 'object', description: 'EXACTLY the fields the matching single-step tool takes (tool/inputs, prompt/outputSchema, expr, op, afterStepId, branch:"then"|"else"|"error", caseName, label, …). Put ALL step fields inside spec — never at the entry level. PER-ITEM WORK is forEach:{overRef,itemVar} INSIDE spec — the default, also for MULTI-STEP per-item work: chain the next entry\'s forEach over the previous one\'s output.results. EXAMPLE — read every listed file, extract from each, then save one row per file: [{tempId:"list",type:"integration_action",spec:{tool:"nextcloud_list_files",inputs:{path:{kind:"literal",value:"/Invoices"}}}},{tempId:"read",type:"integration_action",spec:{tool:"nextcloud_read_file",inputs:{path:{kind:"ref",path:"loop.f.path"}},forEach:{overRef:"steps.$list.output.items",itemVar:"f"}}},{tempId:"extract",type:"data_extraction",spec:{source:{kind:"ref",path:"loop.r.output.content"},fields:[{name:"vendor",type:"string",description:"Supplier name"},{name:"amount",type:"number",description:"Total including VAT"},{name:"due_date",type:"date",description:"Payment due date"}],forEach:{overRef:"steps.$read.output.results",itemVar:"r"}}},{tempId:"save",type:"datatable",spec:{op:"add_row",datatableId:"<id from the Datatables block>",values:{vendor:{kind:"ref",path:"loop.x.output.vendor"}},forEach:{overRef:"steps.$extract.output.results",itemVar:"x"}}}]. Extraction is a data_extraction step (fields = output shape, runs on the admin\'s extraction model); an ai_step is for judgement and writing. A type:"loop" entry is RARE (only when a body must branch); its spec.body steps are FLAT step objects ({id, type, tool|prompt, inputs}) with no nested spec wrapper. PRIVACY SHIELD steps exist ONLY here (no single-step tool) and take a ref PATH STRING, not a binding object: {type:"guard",spec:{sourceRef:"steps.$read.output.content",stopOnFound?,maskOnFound?,hideOnFound?,categories?,confidence?}} branches then (personal data found) / else (clean) — append with afterStepId=<guard>, branch:"then"|"else"; {type:"tokenize",spec:{sourceRef}} hides what it finds reversibly (output.text); {type:"untokenize",spec:{sourceRef}} puts the real values back.' },
                            },
                            required: ['type', 'spec'],
                        },
                    },
                },
                required: ['steps'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_replace_step',
            description: 'Replace an existing step\'s TYPE in place, keeping its id and surrounding wiring so downstream steps.<id>.output.* references survive. Provide the full new spec exactly as you would to builder_add_<newType> (omit afterStepId/branch/caseName — position is inherited). Replacing a branching step (condition/switch) with a non-branching one, or vice-versa, rewrites the outgoing branch edges; the result includes a `rewired` note telling you what to finish wiring. For a same-type field change use builder_update_step instead. EXAMPLE — a Nextcloud Tables row step into a Bee Flow table step: {stepId:"act_1", newType:"datatable", spec:{op:"add_row", datatableId:"<id>", datatableKey:"<key>", values:{…}}}. Readers of the old output fields must be re-pointed (row, id, created).',
            parameters: {
                type: 'object',
                properties: {
                    stepId: { type: 'string' },
                    newType: { type: 'string', enum: [...REPLACEABLE_STEP_TYPES] },
                    spec: { type: 'object', description: 'Full field set for the new type (same shape as the matching builder_add_<type> args, excluding afterStepId/branch/caseName/scope).' },
                },
                required: ['stepId', 'newType', 'spec'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_set_metadata',
            // The same sentence on both schema variants (builderTools/
            // schemaProjection.js repeats it): an automation nobody named ships
            // as "Untitled automation", and "when the ask names a title" was
            // read by every band as "usually not".
            description: 'Name the automation. REQUIRED once per new draft — in your FIRST reply, bundled with the trigger call: title ≤ 60 chars, in the user\'s language, saying what the automation does ("Facturen uit /Invoices naar tabel Facturen"); description = one sentence. When the request states a title, use it verbatim. Call again to rename.',
            parameters: { type: 'object', properties: { title: { type: 'string', description: '≤ 60 chars, the user\'s language, what the automation does.' }, description: { type: 'string', description: 'One sentence.' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_inspect_tool',
            description: 'Look up integration tools\' EXACT input params AND output shape. The catalog only lists names + an input count, so inspect any action with required inputs (to bind the right param names) or whose output you need to chain (to know whether the field is "results"/"items"/"events"). PREFER the batch form: pass `tools:[…]` with EVERY tool you plan to use, in ONE call — never a serial call per tool. Returns per tool: `inputs` ({name:{type,required,description?,enum?}}), `requiredInputs`, and a one-line output `shape` (sourced from runtime samples when available, else the curated schema).',
            parameters: {
                type: 'object',
                properties: {
                    tools: { type: 'array', items: { type: 'string' }, maxItems: 8, description: 'Inspect several tools in ONE call (preferred). Exact tool names from the catalog.' },
                    tool: { type: 'string', description: 'Single exact tool name from the catalog (legacy form — prefer `tools`).' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_summarise',
            description: 'Return a deterministic plain-English summary of the current draft. Call after every batch of mutations so the user sees what changed.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_request_dry_run',
            description: 'Execute the draft in dry-run mode. Call this ONCE, when EVERY planned step exists — never mid-build. Side-effect actions are simulated (no real emails sent, no real issues created); read-only and AI steps run for real. Returns ok + note and, per step, its status and a `_hint` of the REAL runtime keys and shape — trust those over any assumption; only a failed step carries its error and input, a forEach reports its failed items, a step that produced nothing says empty:true. If steps errored, fix them ALL with one builder_update_steps call, then dry-run again (both in the SAME reply — calls execute in order). Only after a clean dry-run (ok:true) should you call builder_finalize.',
            parameters: { type: 'object', properties: { triggerPayload: { type: 'object', description: 'Optional fake trigger payload (used to feed app_event triggers a sample). Omitted or {} on an app_event trigger: the event\'s declared sample is used instead (triggerPayloadSource says which one ran).' }, triggerStepId: { type: 'string', description: 'Which trigger to enter through when the automation has ADDITIONAL triggers (an additional trigger\'s own id). Omit for the primary trigger. Dry-run each root separately.' } } },
        },
    },
    {
        type: 'function',
        function: {
            name: 'builder_finalize',
            description: 'Mark the draft as finalised (is_draft=false). The automation remains INACTIVE until the user clicks Activate in the UI. Only call this after a successful dry-run.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

module.exports = { TOOL_SCHEMAS_PART_5 };
