/**
 * Automations (automations) over MCP — tool surface, draft loading and dispatch.
 *
 * WHY THIS EXISTS
 * ---------------
 * The sibling of appStudio/mcpBuilder.js, for the other half of Studio. Until
 * now an automation could be authored two ways: by talking to the in-product
 * builder agent (routes/ai/automationBuilder.js), or by hand on the canvas.
 * Neither is reachable from an external coding agent, so building a customer's
 * automation meant driving a chat UI turn by turn — or, worse, writing the
 * definition JSON straight into the row and hoping it matched the contract.
 * This module is the third way: the SAME builder toolset, spoken over MCP, so
 * Claude Code in VS Code edits automations live in a running instance.
 *
 * IT IS THE SAME TOOLS, DELIBERATELY
 * ----------------------------------
 * Every mutation still goes through builderTools.applyToolCall → the same
 * binding fixups → persistDraft → automation/validate.js. No second write
 * path, no second validator, no "import a definition blob" back door: a
 * automation built from VS Code is byte-identical in provenance to one built in
 * the product, and the `_fixHint` a rejected call returns is the same string
 * the in-product agent gets.
 *
 * STATELESS, ONE AUTOMATION PER CALL
 * -------------------------------
 * The in-product builder holds one draftWrap for a whole SSE turn. MCP has no
 * turn — each tools/call is its own HTTP request — so the draft is re-read
 * from the store on every call and `automationId` is a REQUIRED argument on
 * every builder_* tool. That is the same trade appStudio/mcpBuilder.js makes,
 * for the same reason: a browser tab open on the same automation cannot silently
 * lose work, and there is no server-side session to expire mid-build.
 *
 * GATING — see routes/mcpAutomations.js for the mount. This module is inert
 * unless AUTOMATION_MCP_ENABLED=1: isEnabled() is the single predicate both
 * the route and the tests read. Behind it sit the bearer token (mcpServer.js)
 * and the `automations` beta feature, which is what gates every authenticated
 * /api/automation route.
 */

'use strict';

const {
    TOOL_SCHEMAS,
    MUTATING_TOOLS,
    applyToolCall,
    persistDraft,
    emptyDefinition,
} = require('./builderTools');
// Lazy inside: it reaches the stores only when called, so requiring this
// module still costs no database.
const { buildDatatableCatalogForUser } = require('./builderDatatableCatalog');

// ── The gate ────────────────────────────────────────────────────────────────
//
// Strict '1' rather than a truthiness helper, for the reason the App Studio
// twin gives: this endpoint authors executable logic with a static token, so
// it should be switched on by someone who meant to — not by an empty string or
// a stray "false" that a tolerant parser waves through.

function isEnabled() {
    return process.env.AUTOMATION_MCP_ENABLED === '1';
}

// ── Tool surface ────────────────────────────────────────────────────────────

/**
 * Tools whose other half lives in routes/ai/automationBuilder.js and would be
 * a protocol nothing implements here:
 *
 *   builder_set_plan          — drives a per-turn to-do list the SSE route
 *                               seeds from the builder-session snapshot and
 *                               streams to the canvas. There is no turn here.
 *   builder_generate_layer    — spawns the thinking-model flowlet sub-agent
 *   builder_generate_layers     via the route's runDelegationTool(), which
 *                               needs the route's model/session context. A
 *                               coding agent builds the layer itself with
 *                               builder_create_layer + the scoped graph tools.
 *
 * Everything else routes through applyToolCall unchanged, including
 * builder_request_dry_run and builder_finalize — the SSE route only
 * post-processes their results for the canvas, it does not implement them.
 */
const ROUTE_ONLY_TOOLS = new Set([
    'builder_set_plan',
    'builder_generate_layer',
    'builder_generate_layers',
]);

/** Tools that need no automation to act on — the entry points. */
const AUTOMATIONLESS_TOOLS = new Set(['automations_get_guide', 'automations_list', 'automations_create']);

const AUTOMATION_ID_PROP = {
    type: 'string',
    description: 'The automation to act on (uuid from automations_list or automations_create). Required on every builder_* tool: each call is independent and re-reads the automation from the database.',
};

/**
 * MCP tool descriptor from an OpenAI-shaped function definition, with
 * `automationId` spliced into the schema.
 *
 * TOOL_SCHEMAS is a module constant the in-product builder sends to the model
 * on every turn, and its byte-stability is load-bearing for prompt caching
 * (schemas.js says so at the top). So this COPIES — automationId goes into a
 * fresh properties object and a fresh required array. Mutating the shared
 * schema here would silently change the cache key of every builder turn on the
 * instance the moment someone enabled MCP.
 */
function toMcpTool(fn) {
    const params = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object' };
    const needsAutomation = !AUTOMATIONLESS_TOOLS.has(fn.name);
    const properties = needsAutomation
        ? { automationId: AUTOMATION_ID_PROP, ...(params.properties || {}) }
        : { ...(params.properties || {}) };
    const required = needsAutomation
        ? ['automationId', ...(Array.isArray(params.required) ? params.required : [])]
        : (Array.isArray(params.required) ? [...params.required] : []);

    // Derived from the same set the dispatcher persists on, so a tool that
    // starts mutating cannot keep advertising itself as read-only by omission.
    // builder_finalize is not in MUTATING_TOOLS (it does not change the
    // definition) but it flips the automation out of draft, which is exactly the
    // kind of call a client should be able to confirm.
    const writes = MUTATING_TOOLS.has(fn.name)
        || fn.name === 'builder_finalize'
        || fn.name === 'automations_create';

    const inputSchema = { ...params, type: 'object', properties };
    if (required.length) inputSchema.required = required;
    else delete inputSchema.required;

    return {
        name: fn.name,
        description: fn.description || '',
        inputSchema,
        annotations: {
            title: fn.name,
            readOnlyHint: !writes,
            // Nothing here deletes an automation; builder_remove_step removes a
            // node INSIDE one. Honest either way: a client that confirms
            // destructive calls should confirm that.
            destructiveHint: writes && /remove|delete/.test(fn.name),
        },
    };
}

/** The three MCP-only tools, in the same OpenAI shape as TOOL_SCHEMAS. */
const AUTOMATION_TOOLS = [
    {
        name: 'automations_get_guide',
        description: 'The automation-builder guide: the trigger catalog, the full step vocabulary with every field, the binding kinds (literal/ref/template/expr), the restricted expression grammar and its functions, and how edges and branches wire together. CALL THIS FIRST, once per session, before authoring anything — the builder_* tool descriptions teach the call protocol only, not the vocabulary, and step types or binding shapes invented without the guide get rejected by the validator.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'automations_list',
        description: 'List the automations this token\'s user owns (id, editorPath — the page that shows it in the product —, title, trigger type, draft/active state, last run). Start here to find the automationId to work on.',
        parameters: {
            type: 'object',
            properties: {
                includeBlocks: { type: 'boolean', description: 'Also list reusable Steps (kind="block"), not just automations. Default false.' },
            },
        },
    },
    {
        name: 'automations_create',
        description: 'Create a new, empty automation owned by this token\'s user and return its automationId. It is created as a DRAFT — nothing runs until you call builder_finalize and the user activates it.',
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Automation title (max 120 chars).' },
                description: { type: 'string', description: 'One or two sentences on what the automation does.' },
            },
            required: ['title'],
        },
    },
];

/** The advertised tool list. Pure — no I/O, safe to call per request. */
function buildToolList() {
    const builder = TOOL_SCHEMAS
        .map((t) => t.function)
        .filter((fn) => fn && !ROUTE_ONLY_TOOLS.has(fn.name));
    return [...AUTOMATION_TOOLS, ...builder].map(toMcpTool);
}

const TOOL_NAMES = new Set([
    ...AUTOMATION_TOOLS.map((t) => t.name),
    ...TOOL_SCHEMAS.map((t) => t.function?.name).filter((n) => n && !ROUTE_ONLY_TOOLS.has(n)),
]);

// ── Draft loading ───────────────────────────────────────────────────────────

/**
 * Build the draftWrap for one call. Mirrors routes/ai/automationBuilder.js's
 * loadOrCreateDraft — same fields, same fallback to emptyDefinition() for a
 * row whose definition is an empty object.
 *
 * Ownership is the same check the store's own update path makes: the automation
 * must belong to this token's user. A shared/published automation is deliberately
 * NOT editable here — publishing shares the RUN, not the source.
 */
async function loadDraft(automationId, userId) {
    const automationStore = require('../stores/automationStore');

    const a = await automationStore.getAutomation(automationId);
    if (!a || a.userId !== userId) {
        return { error: `Automation "${automationId}" not found, or this token's user does not own it. Call automations_list for the ids you own.` };
    }

    const draftWrap = {
        userId,
        orgId: a.organizationId || null,
        automationId: a.id,
        // Distinct prefix so a build driven from an editor is identifiable
        // in logs next to the in-product `bs_…` sessions.
        builderSessionId: `mcp_${a.id}`,
        title: a.title,
        description: a.description,
        def: a.definition && Object.keys(a.definition).length ? a.definition : emptyDefinition(),
    };
    // The tables this user may address, for builder_add_datatable's id/key/
    // column check — the same list the chat route puts on its draftWrap.
    // Re-read per call, like the draft itself: there is no session to cache
    // it on, and a table created in Studio a minute ago must be usable now.
    // null = could not tell → permissive; [] = none → a datatable step is
    // refused (see builderDatatableCatalog.js).
    try { draftWrap._datatables = await buildDatatableCatalogForUser(userId); }
    catch (_) { draftWrap._datatables = null; }
    // And the designed documents, for builder_add_fill_document's id check —
    // same re-read-per-call reasoning: a template designed a minute ago must
    // be fillable now.
    try { draftWrap._documents = await require('./builderDocumentCatalog').buildDocumentCatalogForUser(userId); }
    catch (_) { draftWrap._documents = null; }
    // The tools this user can run and their input schemas, from the same catalog
    // the chat route uses: without them builder_inspect_tool answered `inputs: null`
    // for every tool and input names went unchecked. Unknown → permissive (null).
    try {
        const { buildCatalogForUser } = require('./builderCatalog');
        const catalog = await buildCatalogForUser(userId, await offlineSession(userId));
        draftWrap._inputSchemasByTool = {};
        for (const app of (catalog?.apps || [])) {
            for (const act of (app.actions || [])) {
                if (act && act.name && act.inputSchema) draftWrap._inputSchemasByTool[act.name] = act.inputSchema;
            }
        }
        draftWrap._availableToolNames = catalog?.toolNames instanceof Set ? catalog.toolNames : null;
    } catch (_) { /* permissive, as before */ }
    // What the draft's tools really returned on this user's last live run, for
    // the builder's path checks — the same read the chat route makes per turn.
    draftWrap._runtimeShapes = await loadRuntimeShapes(draftWrap.def, userId);
    // The chat's "inspect before you bind" gate remembers inspections for one SSE
    // turn. Every MCP call is its own turn, so an inspect could never count and a
    // partial add would be refused forever: the gate stays off here.
    draftWrap._inspectGate = false;
    return { draftWrap };
}

// ── Runtime shapes ──────────────────────────────────────────────────────────

const RUNTIME_SHAPE_MAX_TOOLS = 40;
const RUNTIME_SHAPE_TIMEOUT_MS = 1500;

/** The distinct integration_action tools of a definition: loop bodies, parallel branches and layers included. */
function draftToolNames(def) {
    const names = new Set();
    const walk = (steps) => {
        for (const s of (Array.isArray(steps) ? steps : [])) {
            if (!s || typeof s !== 'object') continue;
            if (s.type === 'integration_action' && typeof s.tool === 'string' && s.tool) names.add(s.tool);
            walk(s.body);
            for (const b of (Array.isArray(s.branches) ? s.branches : [])) walk(Array.isArray(b) ? b : b?.steps);
        }
    };
    walk(def?.steps);
    for (const layer of Object.values(def?.layers && typeof def.layers === 'object' ? def.layers : {})) walk(layer?.steps);
    return [...names].slice(0, RUNTIME_SHAPE_MAX_TOOLS);
}

/**
 * `{ [tool]: descriptor }` for the integration_action tools of a draft: what
 * each one really returned on this user's last live run (shapeCache.js). Set
 * as `draftWrap._runtimeShapes` at the start of a builder turn — here and by
 * the chat route — and read by builderTools/refCheck.js and outputFields.js,
 * which prefer it to the curated shape, so a path into a field only the real
 * output has is not refused as unknown.
 *
 * Cheap and failure-tolerant: one cache read per distinct tool (capped), all
 * in parallel, under a deadline. A read that throws or has not answered by
 * then only means that tool has no runtime shape this turn; this never
 * throws. `getShape` is injectable for tests.
 */
async function loadRuntimeShapes(def, userId, {
    getShape = (args) => require('./shapeCache').getShape(args),
    timeoutMs = RUNTIME_SHAPE_TIMEOUT_MS,
} = {}) {
    const found = {};
    const tools = draftToolNames(def);
    if (!tools.length) return found;
    const reads = Promise.all(tools.map(async (toolName) => {
        try {
            const shape = await getShape({ userId, toolName });
            if (shape) found[toolName] = shape;
        } catch { /* no runtime shape for this tool this turn */ }
    }));
    // Cleared as soon as the reads are in, so it holds nothing open longer.
    let timer;
    const deadline = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); });
    try { await Promise.race([reads, deadline]); } finally { clearTimeout(timer); }
    // A snapshot: a read that answers after the deadline changes nothing.
    return { ...found };
}

// ── The MCP-only tools ──────────────────────────────────────────────────────

/**
 * The offline session unattended automations run with — the same builder
 * automation/triggerBus gives the scheduler, so a connector-bound user reaches
 * their apps here exactly as they would in a scheduled run. There is no cookie
 * on an MCP request; this is the honest substitute, not a privilege escalation:
 * getIntegrationTools still applies every org/group/personal gate to it.
 */
async function offlineSession(userId) {
    const { loadSession } = require('./triggerBus');
    return loadSession(userId).catch(() => null);
}

async function runGetGuide(userId) {
    const { buildFullSystemPrompt, renderTurnPreferences } = require('./builderPrompt');
    const { buildCatalogForUser } = require('./builderCatalog');
    const session = await offlineSession(userId);
    const catalog = await buildCatalogForUser(userId, session);
    // …and THIS user's datatables, so the guide's "Datatables you may use"
    // block names real table ids and column keys, as the chat route's does.
    try { catalog.datatables = await buildDatatableCatalogForUser(userId); }
    catch (_) { catalog.datatables = null; }
    try { catalog.documents = await require('./builderDocumentCatalog').buildDocumentCatalogForUser(userId); }
    catch (_) { catalog.documents = null; }
    // The FULL variant, built against THIS user's catalog, so the guide never
    // names an app they cannot reach — the same prompt the in-product builder
    // gets on its first turn.
    const guide = buildFullSystemPrompt({
        catalog,
        codeStepEnabled: false,
    });
    // The guide says the timezone and the other per-turn preferences arrive
    // in a "This turn" note right before the user's message. The chat route
    // sends that as a late per-turn message; an MCP client has no such turn,
    // so the reference pointed at nothing and the guide had lost the fixed
    // timezone it used to render inline (dropped when buildFullSystemPrompt
    // lost its userTimezone parameter). Ship the note once, appended.
    const turnNote = renderTurnPreferences({ userTimezone: 'Europe/Amsterdam' });
    return { guide: turnNote ? `${guide}\n\n${turnNote}` : guide };
}

/**
 * Where the automation opens in the product, relative to the app's origin. A
 * coding agent that edits over MCP can hand this to a browser to SEE what the
 * user sees (canvas, step panels, mappings) instead of guessing from JSON.
 */
const editorPath = (id) => `/app/studio/automations/${id}`;

async function runList(userId, args) {
    const automationStore = require('../stores/automationStore');
    const rows = await automationStore.getAutomationsForUser(userId);
    const includeBlocks = args?.includeBlocks === true;
    return {
        automations: (rows || [])
            .filter((a) => includeBlocks || (a.kind || 'automation') === 'automation')
            .map((a) => ({
                automationId: a.id,
                editorPath: editorPath(a.id),
                title: a.title,
                description: a.description || '',
                kind: a.kind || 'automation',
                triggerType: a.triggerType,
                isDraft: !!a.isDraft,
                isActive: !!a.isActive,
                // Canvas annotations (BFSF-411) are not steps the automation
                // runs — counting them here would inflate "12 steps" to
                // include sticky notes nobody wired into the flow.
                stepCount: Array.isArray(a.definition?.steps)
                    ? a.definition.steps.filter((s) => s?.type !== 'note').length : 0,
                lastRunAt: a.lastRunAt || null,
                lastStatus: a.lastStatus || null,
                updatedAt: a.updatedAt,
            })),
    };
}

async function runCreate(userId, args) {
    const title = typeof args?.title === 'string' ? args.title.trim() : '';
    if (!title) return { error: 'A title is required to create an automation.' };

    // orgId stays null: persistDraft backfills it from the user record when a
    // draft has none. That backfill exists precisely because a row created
    // with organization_id NULL bypasses the org Privacy Shield at run time —
    // duplicating the lookup here would just be a second place to get it wrong.
    const draftWrap = {
        userId,
        orgId: null,
        automationId: null,
        builderSessionId: `mcp_new_${Date.now().toString(36)}`,
        title: title.slice(0, 120),
        description: typeof args?.description === 'string' ? args.description.slice(0, 500) : '',
        def: emptyDefinition(),
    };

    // persistDraft creates the row when automationId is null — the same
    // first-mutation path the in-product builder takes.
    const created = await persistDraft(draftWrap);
    if (created && created.error) return created;

    return {
        automationId: draftWrap.automationId,
        editorPath: editorPath(draftWrap.automationId),
        title: draftWrap.title,
        next: 'Call automations_get_guide if you have not yet, then builder_propose_trigger to set how it starts (builder_add_trigger for extra entry points), then the builder_add_* tools for the steps. Verify with builder_request_dry_run before builder_finalize.',
    };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Run one MCP tool call. Returns `{ result }` — a plain JSON-able report —
 * plus an optional `text` that replaces the JSON serialisation. Never throws:
 * a rejected call comes back as { error, _fixHint } like every other builder
 * tool result, because a coding agent recovers from a described error and
 * cannot recover from a transport-level exception.
 */
async function callTool(name, rawArgs, { userId }) {
    if (!TOOL_NAMES.has(name)) {
        return { result: { error: `Unknown tool: ${name}` } };
    }

    const args = (rawArgs && typeof rawArgs === 'object') ? { ...rawArgs } : {};

    if (name === 'automations_get_guide') {
        const result = await runGetGuide(userId);
        // Tens of kb of prose, and JSON.stringify would ship it as one escaped
        // string with every newline as \n — technically readable, painful to
        // actually read. It is documentation: send it as text.
        return { result, text: result.guide };
    }
    if (name === 'automations_list') return { result: await runList(userId, args) };
    if (name === 'automations_create') return { result: await runCreate(userId, args) };

    const automationId = typeof args.automationId === 'string' ? args.automationId.trim() : '';
    delete args.automationId; // never reaches the builder tool — it is our envelope
    if (!automationId) {
        return { result: { error: `${name} needs an automationId. Call automations_list to find one, or automations_create to make one.` } };
    }

    const loaded = await loadDraft(automationId, userId);
    if (loaded.error) return { result: { error: loaded.error } };
    const { draftWrap } = loaded;

    const result = await applyToolCall(name, args, draftWrap);
    const ok = !(result && typeof result === 'object' && result.error);

    // Persist on the same condition the SSE route does (chatStream.js
    // persists after EVERY mutator, error or not). builder_finalize persists
    // itself inside the tool (it flips is_draft through persistDraft with
    // finalize:true); a second save here would undo that flag.
    //
    // A PARTIAL builder_add_steps (entries 0..i-1 built, entry i refused) is
    // an error result whose built prefix sits in draftWrap.def. Reproduced
    // 2026-09-13: gated on `ok`, that prefix was never written, the result
    // still promised "built … stay built", the next call re-read the row
    // without it, and obeying resendAs then wrote an edge from an id that
    // no longer existed (edge.unknown_from).
    const partial = !ok && result && Array.isArray(result.added) && result.added.length > 0;
    if (partial) {
        // The $tempId / "not added twice" halves of the contract hold inside
        // ONE draftWrap, which this surface rebuilds per call — say so, or
        // the caller resends the built entries and adds them again.
        result._fixHint = `${result._fixHint || 'Reject reason: see the error.'} Over MCP a $tempId lives for THIS CALL only: the built entries are saved — reference them by the real ids in added[]/idMap, and do NOT resend them (a fresh call does not recognise them and would add them again).`;
        (result._warnings = result._warnings || []).push(`Saved the ${result.added.length} built ${result.added.length === 1 ? 'entry' : 'entries'} (${result.added.map(a => a.id).join(', ')}) before refusing entry ${result.failedIndex}.`);
    }
    if ((ok || partial) && MUTATING_TOOLS.has(name)) {
        const persisted = await persistDraft(draftWrap);
        if (persisted && persisted.error) {
            return {
                result: {
                    error: persisted.error,
                    _fixHint: 'The automation changed underneath this call — most likely the builder is open on it in a browser. Re-read with builder_summarise and re-apply.',
                },
            };
        }
        // persistDraft attaches the validator's errors rather than throwing:
        // a draft is allowed to be incomplete, but a caller that cannot see
        // the errors will keep building on top of them.
        if (persisted && Array.isArray(persisted.validationErrors) && persisted.validationErrors.length) {
            return {
                result: {
                    ...(result && typeof result === 'object' && !Array.isArray(result) ? result : { result }),
                    automationId: draftWrap.automationId,
                    validationErrors: persisted.validationErrors,
                },
            };
        }
    }

    // Echo the id every call so the caller can see its writes landing — a
    // partial batch wrote too.
    let payload = result;
    if ((ok || partial) && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        payload = { ...payload, automationId: draftWrap.automationId };
    }

    return { result: payload };
}

module.exports = {
    isEnabled,
    buildToolList,
    callTool,
    loadDraft,
    loadRuntimeShapes,
    TOOL_NAMES,
    ROUTE_ONLY_TOOLS,
    AUTOMATIONLESS_TOOLS,
    _test: { toMcpTool, AUTOMATION_TOOLS },
};
