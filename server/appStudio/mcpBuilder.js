/**
 * App Studio over MCP — tool surface, draft loading and dispatch.
 *
 * WHY THIS EXISTS
 * ---------------
 * A new App Studio app could be authored two ways until now: by talking to the
 * in-product builder agent (routes/ai/appStudioBuilder.js), or by writing a
 * template module into appStudio/templates/ — which is baked into the API image
 * by `COPY . .` (server/Dockerfile), so every iteration on a customer app meant
 * edit → rebuild → push → redeploy. This module is the third way: the SAME
 * builder toolset, spoken over MCP, so an external coding agent (Claude Code in
 * VS Code) edits apps live in a running instance. Nothing is baked in and the
 * image never has to change again.
 *
 * IT IS THE SAME TOOLS, DELIBERATELY
 * ----------------------------------
 * Every mutation still goes through builderTools.applyToolCall → definitionOps
 * → canonicalizeAppDefinition → persistDraft (CAS). No second write path, no
 * second validator, no "import a definition blob" back door: an app built from
 * VS Code is byte-identical in provenance to one built in the product, and any
 * repair the canonicalizer makes comes back as `_hints` exactly as it does for
 * the in-product agent.
 *
 * STATELESS, ONE APP PER CALL
 * ---------------------------
 * The in-product builder holds one draftWrap for a whole SSE turn. MCP has no
 * turn — each tools/call is its own HTTP request — so the draft is re-read from
 * the store on every call and `appId` is a REQUIRED argument on every app_*
 * tool. That is not a limitation to work around: it means a browser tab open on
 * the same app cannot silently lose work (persistDraft's CAS sees the newer
 * version and reports a conflict) and there is no server-side session to expire
 * mid-build.
 *
 * GATING — see routes/mcpStudio.js for the mount. This module is inert unless
 * STUDIO_MCP_ENABLED=1: isEnabled() is the single predicate both the route and
 * the tests read.
 */

'use strict';

const {
    TOOL_SCHEMAS,
    MUTATING_TOOLS,
    DATA_MODEL_TOOLS,
    applyToolCall,
    persistDraft,
} = require('./builderTools');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { emptyDefinition } = require('./componentSpecs');
const log = require('../telemetry/log');

// ── The gate ────────────────────────────────────────────────────────────────
//
// Module-local predicate + conditional mount, the house pattern (compare
// services/webpageRuntimeManager.js isEnabled() / index.js). Strict '1' rather
// than a truthiness helper: this endpoint writes to a user's apps with a static
// token, so it should be switched on by someone who meant to, not by an empty
// string or a stray "false" that a tolerant parser waves through.

function isEnabled() {
    return process.env.STUDIO_MCP_ENABLED === '1';
}

// ── Tool surface ────────────────────────────────────────────────────────────

/**
 * Tools that exist only for the in-product conversational builder:
 * app_propose_plan is COMPLETED by the SSE route (it mints a planId, strips the
 * echoed plan and ends the turn) and app_mark_phase drives a progress bar and a
 * revert checkpoint. Neither has a counterpart here, and advertising a tool
 * whose other half lives in a route this endpoint never runs would teach the
 * client a protocol nothing implements.
 */
const ROUTE_ONLY_TOOLS = new Set(['app_propose_plan', 'app_mark_phase']);

/** Tools that need no app to act on — the entry points. */
const APPLESS_TOOLS = new Set(['studio_get_guide', 'studio_list_apps', 'studio_create_app']);

const APP_ID_PROP = {
    type: 'string',
    description: 'The app to act on (app_… id from studio_list_apps or studio_create_app). Required on every app_* tool: each call is independent and re-reads the app from the database.',
};

/**
 * MCP tool descriptor from an OpenAI-shaped function definition, with `appId`
 * spliced into the schema.
 *
 * TOOL_SCHEMAS is a module constant that the in-product builder sends to the
 * model on every turn, and its byte-stability is load-bearing for prompt
 * caching (schemas.js says so at the top). So this COPIES — appId goes into a
 * fresh properties object and a fresh required array. Mutating the shared
 * schema here would silently change the cache key of every builder turn on the
 * instance the moment someone enabled MCP.
 */
function toMcpTool(fn) {
    const params = (fn.parameters && typeof fn.parameters === 'object') ? fn.parameters : { type: 'object' };
    const needsApp = !APPLESS_TOOLS.has(fn.name);
    const properties = needsApp
        ? { appId: APP_ID_PROP, ...(params.properties || {}) }
        : { ...(params.properties || {}) };
    const required = needsApp
        ? ['appId', ...(Array.isArray(params.required) ? params.required : [])]
        : (Array.isArray(params.required) ? [...params.required] : []);

    // Writes are the ones a client should be able to confirm before running.
    // Derived from the same two sets the route persists on, so a tool that
    // starts mutating cannot keep advertising itself as read-only by omission.
    // app_save_as_template writes to studio_app_templates rather than to the
    // app, so it is deliberately NOT in MUTATING_TOOLS (nothing to persist) —
    // but it does create a row somebody else can install, which is exactly the
    // kind of call a client should be able to confirm.
    const writes = MUTATING_TOOLS.has(fn.name)
        || DATA_MODEL_TOOLS.has(fn.name)
        || fn.name === 'app_finalize'
        || fn.name === 'app_apply_template'
        || fn.name === 'app_save_as_template'
        || fn.name === 'studio_create_app';

    // Spread the source schema so sibling JSON Schema keys survive, then set
    // the two we own. `required` is deleted rather than left when empty: a
    // stale required array inherited from the spread would demand fields this
    // envelope had just stripped.
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
            // Nothing here deletes an app; the destructive tools remove a
            // screen/node/table INSIDE one. Honest either way: a client that
            // confirms destructive calls should confirm those.
            destructiveHint: writes && /remove|delete/.test(fn.name),
        },
    };
}

/** The three MCP-only tools, in the same OpenAI shape as TOOL_SCHEMAS. */
const STUDIO_TOOLS = [
    {
        name: 'studio_get_guide',
        description: 'The App Studio builder guide: how to compose screens/sections/components, the full component catalog with every prop and style knob, the action and sequence-step vocabulary, binding kinds and the formula functions. CALL THIS FIRST, once per session, before authoring anything — the app_* tool descriptions teach the call protocol only, not the vocabulary, and ids/props invented without the catalog get rejected by the validator.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_list_apps',
        description: 'List the App Studio apps this token\'s user owns (id, name, description, version, published state, template provenance). Start here to find the appId to work on.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_create_app',
        description: 'Create a new, empty App Studio app owned by this token\'s user and return its appId. Optionally start from a built-in template (see app_list_templates for ids) — a template gives you screens, tables and seed rows to edit rather than a blank canvas.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'App name (max 80 chars).' },
                description: { type: 'string', description: 'One or two sentences on what the app does.' },
                icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList".' },
                templateId: { type: 'string', description: 'Optional template id to install into the new app (app_list_templates lists them).' },
            },
            required: ['name'],
        },
    },
];

/** The advertised tool list. Pure — no I/O, safe to call per request. */
function buildToolList() {
    const builder = TOOL_SCHEMAS
        .map((t) => t.function)
        .filter((fn) => fn && !ROUTE_ONLY_TOOLS.has(fn.name));
    return [...STUDIO_TOOLS, ...builder].map(toMcpTool);
}

const TOOL_NAMES = new Set([
    ...STUDIO_TOOLS.map((t) => t.name),
    ...TOOL_SCHEMAS.map((t) => t.function?.name).filter((n) => n && !ROUTE_ONLY_TOOLS.has(n)),
]);

// ── Screenshot budget ───────────────────────────────────────────────────────
//
// app_screenshot's own cap is per-TURN (draftWrap._screenshotsThisTurn), and a
// stateless endpoint that reloads the draft every call would reset it to zero
// every time — turning an 8-per-turn ceiling into no ceiling at all. Each
// render is a headless browser page, so replace it with an equivalent rolling
// per-user budget rather than dropping it.

const SHOT_WINDOW_MS = 10 * 60 * 1000;
const SHOT_MAX_PER_WINDOW = 24;
const _shotBudget = new Map(); // userId → { count, resetAt }

function takeScreenshotBudget(userId) {
    const now = Date.now();
    const entry = _shotBudget.get(userId);
    if (!entry || entry.resetAt <= now) {
        _shotBudget.set(userId, { count: 1, resetAt: now + SHOT_WINDOW_MS });
        return true;
    }
    if (entry.count >= SHOT_MAX_PER_WINDOW) return false;
    entry.count += 1;
    return true;
}

// ── Draft loading ───────────────────────────────────────────────────────────

/** Row counts keyed by table id (the store may key either id or key). */
function normalizeRowCounts(dataModel, counts) {
    const out = {};
    const c = (counts && typeof counts === 'object') ? counts : {};
    for (const t of (dataModel && Array.isArray(dataModel.tables)) ? dataModel.tables : []) {
        if (!t || typeof t.id !== 'string') continue;
        const n = c[t.id] !== undefined ? c[t.id] : c[t.key];
        if (n !== undefined) out[t.id] = Math.max(0, parseInt(n, 10) || 0);
    }
    return out;
}

/**
 * Build the draftWrap for one call. Mirrors routes/ai/appStudioBuilder.js's
 * per-turn load: canonical definition + the data side (model, version, row
 * counts, dataset ids) that the data tools mutate through CAS and that
 * app_finalize's data-reference checks read.
 *
 * Ownership is checked with canWriteStudioApp — the same predicate the REST
 * routes use — so a token can only reach apps its user could edit in the UI.
 */
async function loadDraft(appId, userId) {
    const studioAppStore = require('../stores/studioAppStore');
    const studioAppDataStore = require('../stores/studioAppDataStore');

    const app = await studioAppStore.getStudioApp(appId);
    if (!app || !studioAppStore.canWriteStudioApp(app, userId)) {
        return { error: `App "${appId}" not found, or this token's user cannot edit it. Call studio_list_apps for the ids you own.` };
    }

    const { def } = canonicalizeAppDefinition(
        app.definition && Object.keys(app.definition).length ? app.definition : emptyDefinition(app.name),
    );

    const draftWrap = {
        userId,
        orgId: app.organizationId || null,
        appId: app.id,
        version: app.definitionVersion,
        // Distinct prefix so a build driven from an editor is identifiable in
        // logs next to the in-product `as_…` sessions.
        builderSessionId: `mcp_${app.id}`,
        def,
        // app_screenshot words its result differently for a blind model. The
        // caller here is a coding agent that is shown the image content block,
        // so it is told to actually look at it.
        modelSupportsVision: true,
    };

    // Best-effort, exactly as the SSE route: on a store error the data fields
    // stay unset and validate.js skips the data-reference checks for this call
    // rather than failing the whole build.
    try {
        const dataMeta = await studioAppDataStore.getDataModel(appId, userId);
        draftWrap.dataModel = dataMeta?.model ?? null;
        draftWrap.dataModelVersion = dataMeta?.modelVersion ?? 0;
        draftWrap.rowCounts = normalizeRowCounts(draftWrap.dataModel, dataMeta?.rowCounts);
        const datasets = await studioAppDataStore.listDatasets(appId, userId);
        draftWrap.datasetIds = (datasets || []).map((d) => ({ id: d.id, name: d.name }));
    } catch (e) {
        log.warn(`[studio-mcp] data-model load failed for ${appId} (checks skipped): ${e.message}`);
    }

    return { draftWrap };
}

// ── The MCP-only tools ──────────────────────────────────────────────────────

async function runGetGuide() {
    const { buildSystemPrompt } = require('./builderPrompt');
    // toolset 'full' is the same menu this endpoint advertises, so the guide
    // never names a tool the caller does not have.
    return { guide: buildSystemPrompt({ toolset: 'full' }) };
}

async function runListApps(userId) {
    const studioAppStore = require('../stores/studioAppStore');
    const rows = await studioAppStore.getStudioAppsByUser(userId);
    return {
        apps: (rows || []).map((a) => ({
            appId: a.id,
            name: a.name,
            description: a.description || '',
            icon: a.icon || null,
            version: a.definitionVersion,
            published: !!a.isPublished,
            templateId: a.templateId || null,
            updatedAt: a.updatedAt,
        })),
    };
}

async function runCreateApp(userId, args) {
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return { error: 'A name is required to create an app.' };

    // orgId stays null: persistDraft backfills it from the user record when a
    // draft has none (the same reason the automation builder does — a row
    // created with organization_id NULL bypasses org-scoped gates later). No
    // session on this path means no better source, and duplicating the lookup
    // here would just be a second place to get it wrong.
    const draftWrap = {
        userId,
        orgId: null,
        appId: null,
        version: null,
        builderSessionId: `mcp_new_${Date.now().toString(36)}`,
        def: emptyDefinition(name),
        modelSupportsVision: true,
        dataModel: null,
        dataModelVersion: 0,
        rowCounts: {},
        datasetIds: [],
    };

    // Go through the ordinary meta tool so name/description/icon are validated
    // and clamped the one way, then persist to mint the row (persistDraft
    // creates when appId is null — the same first-mutation path the in-product
    // builder takes).
    const meta = await applyToolCall('app_set_meta', {
        name,
        ...(typeof args?.description === 'string' ? { description: args.description } : {}),
        ...(typeof args?.icon === 'string' ? { icon: args.icon } : {}),
    }, draftWrap);
    if (meta && meta.error) return meta;

    const persisted = await persistDraft(draftWrap);
    if (persisted.error) return persisted;

    if (typeof args?.templateId === 'string' && args.templateId) {
        const applied = await applyToolCall('app_apply_template', { templateId: args.templateId }, draftWrap);
        if (applied && applied.error) {
            // The app exists — say so, so the caller edits it rather than
            // creating a second one on retry.
            return { appId: draftWrap.appId, version: draftWrap.version, templateError: applied.error };
        }
        return { appId: draftWrap.appId, version: draftWrap.version, template: applied };
    }

    return {
        appId: draftWrap.appId,
        version: draftWrap.version,
        name: draftWrap.def.meta?.name || name,
        next: 'Call studio_get_guide if you have not yet, then build with app_upsert_table / app_add_screen / app_add_components, and verify with app_dry_run and app_screenshot before app_finalize.',
    };
}

// ── Dispatch ────────────────────────────────────────────────────────────────

/**
 * Run one MCP tool call. Returns `{ result }` — a plain JSON-able report — plus
 * an optional `image` ({ data, mimeType, caption }) for app_screenshot and an
 * optional `text` that replaces the JSON serialisation of the result. Never
 * throws: a rejected call comes back as { error, _fixHint } like every other
 * builder tool result, because a coding agent recovers from a described error
 * and cannot recover from a transport-level exception.
 */
async function callTool(name, rawArgs, { userId }) {
    if (!TOOL_NAMES.has(name)) {
        return { result: { error: `Unknown tool: ${name}` } };
    }

    const args = (rawArgs && typeof rawArgs === 'object') ? { ...rawArgs } : {};

    if (name === 'studio_get_guide') {
        const result = await runGetGuide();
        // 68kb of prose, and JSON.stringify would ship it as one escaped
        // string with every newline as \n — technically readable, painful to
        // actually read. It is documentation: send it as text.
        return { result, text: result.guide };
    }
    if (name === 'studio_list_apps') return { result: await runListApps(userId) };
    if (name === 'studio_create_app') return { result: await runCreateApp(userId, args) };

    const appId = typeof args.appId === 'string' ? args.appId.trim() : '';
    delete args.appId; // never reaches the builder tool — it is our envelope
    if (!appId) {
        return { result: { error: `${name} needs an appId. Call studio_list_apps to find one, or studio_create_app to make one.` } };
    }

    if (name === 'app_screenshot' && !takeScreenshotBudget(userId)) {
        return {
            result: {
                content: `Screenshot budget spent (${SHOT_MAX_PER_WINDOW} per ${SHOT_WINDOW_MS / 60000} minutes). Each render is a headless browser page. Keep building from app_dry_run's findings; the budget refills.`,
            },
        };
    }

    const loaded = await loadDraft(appId, userId);
    if (loaded.error) return { result: { error: loaded.error } };
    const { draftWrap } = loaded;

    const result = await applyToolCall(name, args, draftWrap);
    const ok = !(result && typeof result === 'object' && result.error);

    // Persist on exactly the same condition the SSE route does. The data tools
    // (DATA_MODEL_TOOLS) and app_finalize/app_apply_template already persisted
    // themselves inside the tool; a second CAS save here would fight them.
    if (ok && MUTATING_TOOLS.has(name)) {
        const persisted = await persistDraft(draftWrap);
        if (persisted.error) {
            return {
                result: {
                    error: persisted.error,
                    _fixHint: 'The app changed underneath this call — most likely the App Studio editor is open on it in a browser. Re-read with app_get_draft and re-apply.',
                },
            };
        }
    }

    // The PNG must not be stringified into the text payload: a base64 data URL
    // of a full screen is hundreds of KB of useless tokens. Lift it out into a
    // real MCP image block and strip the private fields from the report.
    let image = null;
    let payload = result;
    if (name === 'app_screenshot' && result && typeof result === 'object' && result._screenshotDataUrl) {
        const m = /^data:([^;]+);base64,(.+)$/s.exec(result._screenshotDataUrl);
        if (m) image = { mimeType: m[1], data: m[2], caption: result._screenshotCaption || 'Screenshot' };
        const { _screenshotDataUrl, _screenshotCaption, ...rest } = result;
        payload = rest;
    }

    // Echo the version every call so the caller can see its writes landing and
    // spot a conflicting editor immediately.
    if (ok && payload && typeof payload === 'object' && !Array.isArray(payload)) {
        payload = { ...payload, appId: draftWrap.appId, version: draftWrap.version };
    }

    return { result: payload, image };
}

module.exports = {
    isEnabled,
    buildToolList,
    callTool,
    loadDraft,
    normalizeRowCounts,
    TOOL_NAMES,
    ROUTE_ONLY_TOOLS,
    APPLESS_TOOLS,
    _test: { toMcpTool, takeScreenshotBudget, SHOT_MAX_PER_WINDOW, _shotBudget },
};
