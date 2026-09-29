/**
 * App Studio builder tools — read-only inspection: app_dry_run, the
 * app_screenshot visual check, draft reads (app_get_draft, app_find_nodes),
 * the owner's routines (app_list_automations / app_inspect_automation) and
 * the catalog on demand (app_inspect_catalog). None of these mutate the draft.
 */

'use strict';

const { EVENT_NAMES, COMPONENT_SPECS, COMPONENT_TYPES, STEP_KINDS } = require('../componentSpecs');
const { pickClosestId } = require('../../automation/validate/helpers');
const { canonicalComponentType } = require('./componentAliases');
const { INSPECT_CATALOG_MAX_COMPONENTS, INSPECT_CATALOG_MAX_STEPS } = require('./schemas');

/**
 * app_dry_run — pre-flight the app read-only (STATIC + DATA + asRole + ACTION
 * passes) so empty-table bindings / empty role views / bad sequence steps
 * surface before app_finalize. Wraps appDryRun.js; NEVER throws (a store/DB
 * failure degrades to a clean tool error the model can act on). Read tool —
 * not in MUTATING_TOOLS, so it neither persists nor emits a draft.
 */
async function applyDryRun(draftWrap, args) {
    const { appDryRun } = require('../appDryRun');
    const screenId = typeof args?.screenId === 'string' && args.screenId ? args.screenId : null;
    const asRole = typeof args?.asRole === 'string' && args.asRole ? args.asRole : null;

    // The persisted app row is only needed for the DATA/asRole passes; a
    // never-saved draft still gets the STATIC pass (app stays null → data
    // bindings report skipped:'no_data').
    let app = null;
    if (draftWrap.appId) {
        try {
            const studioAppStore = require('../../stores/studioAppStore');
            app = await studioAppStore.getStudioApp(draftWrap.appId);
        } catch (_) { app = null; }
    }
    try {
        return await appDryRun({
            def: draftWrap.def,
            dataModel: draftWrap.dataModel ?? null,
            datasets: draftWrap.datasetIds || [],
            app,
            appId: draftWrap.appId || null,
            ownerId: draftWrap.userId,
        }, { screenId, asRole });
    } catch (e) {
        return { error: `Dry-run failed: ${e.message}`, _fixHint: 'This is a transient read error — retry app_dry_run, or continue with app_finalize (which re-runs the static checks).' };
    }
}

// ── Visual verification (app_screenshot) ─────────────────────────────

// Each render is a real headless-browser round trip; a turn iterating on
// styling could otherwise spam them and starve the shared browser.
//
// Raised 3 → 8. Three was a diagnosis budget, not a build budget: the honest
// loop is LOOK → change → LOOK AGAIN, which costs two renders per fix, so
// three bought one confirmed fix and half of a second one. A real session ran
// out mid-diagnosis twice, concluded from the un-rechecked half that the
// platform could not do live form binding (it can), and rebuilt a whole app on
// that. Eight is four before/after pairs — enough to diagnose one screen and
// confirm the fix, twice over — and still a hard bound on retry storms, since
// a FAILED render consumes the budget too.
const MAX_SCREENSHOTS_PER_TURN = 8;

// Mirrors services/appStudioRender.js VIEWPORTS. Only the named presets are
// exposed: a free-form {width,height} would let a builder shoot a 1×20000 strip
// and call it a screen.
const SCREENSHOT_VIEWPORTS = new Set(['desktop', 'tablet', 'mobile']);

/**
 * app_screenshot — render one screen of the draft in the shared headless
 * browser (services/appStudioRender) and hand back a PNG of what it actually
 * looks like, with its real data.
 *
 * The result's `content` stays a plain STRING for the model (OpenAI/Mistral
 * reject non-string tool-message content); the image travels on the
 * `_screenshotDataUrl` side channel, which the route turns into an SSE
 * `image` event for the user and — vision-capable models only — a user
 * image message for the model (same split as routes/ai/webpageChat.js).
 * `draftWrap.modelSupportsVision` (set by the route) only steers the wording.
 *
 * The render service is an optional heavyweight edge — the runtime bundle is
 * built from agent-hub and vendored separately — so it is required lazily
 * and every failure mode (missing module, missing bundle, no browser,
 * timeout) degrades to a readable sentence. NEVER throws, never `error`s:
 * a failed screenshot must not derail the build loop.
 */
async function applyAppScreenshot(draftWrap, args) {
    // Screenshots read the PERSISTED app's data; a draft that has never been
    // saved has nothing meaningful to show yet — and the guard keeps the
    // browser edge unreachable until a real build exists.
    if (!draftWrap.appId) {
        return { content: 'No screenshot yet: the draft has not been saved. Build something first — after the first mutation the app persists and screenshots work.' };
    }
    if ((draftWrap._screenshotsThisTurn || 0) >= MAX_SCREENSHOTS_PER_TURN) {
        return { content: `That is all ${MAX_SCREENSHOTS_PER_TURN} screenshots for this turn — the budget refills on the next one, so nothing is lost. Keep building: make the edits you already know you need, and open the next turn by shooting the screen you changed to confirm it.` };
    }

    let renderAppScreenshot;
    try {
        ({ renderAppScreenshot } = require('../../services/appStudioRender'));
    } catch (_) { /* not shipped in this build — guard below */ }
    if (typeof renderAppScreenshot !== 'function') {
        return { content: 'Screenshots are not available in this deployment (no render service) — rely on app_dry_run and continue building.' };
    }

    const screenId = typeof args?.screenId === 'string' && args.screenId ? args.screenId : null;
    const asRole = typeof args?.asRole === 'string' && args.asRole ? args.asRole : null;
    // The renderer has always supported three viewports; only the tool schema
    // never exposed one, so a builder could not check a layout at phone width —
    // precisely where a 12-column row wraps badly.
    const viewport = SCREENSHOT_VIEWPORTS.has(args?.viewport) ? args.viewport : 'desktop';

    // The app row is what lets the render read real table rows (owner id +
    // data scoping) — same lookup as applyDryRun, same tolerance.
    let app = null;
    try {
        const studioAppStore = require('../../stores/studioAppStore');
        app = await studioAppStore.getStudioApp(draftWrap.appId);
    } catch (_) { app = null; }

    draftWrap._screenshotsThisTurn = (draftWrap._screenshotsThisTurn || 0) + 1;
    let shot;
    try {
        shot = await renderAppScreenshot({
            app,
            definition: draftWrap.def,
            model: draftWrap.dataModel ?? null,
            screenId,
            asRole,
            viewport,
        });
    } catch (e) {
        // The service contract is "never throws" — this is belt-and-braces.
        shot = { ok: false, reason: e.message };
    }
    if (!shot || shot.ok !== true || !shot.dataUrl) {
        return { content: `No screenshot: ${(shot && shot.reason) || 'the renderer returned nothing'}. Continue building — only retry after you have fixed the cause.` };
    }

    const rendered = screenId ? (draftWrap.def.screens || []).find((s) => s && s.id === screenId) : null;
    const label = rendered ? `"${rendered.name || rendered.id}"` : 'the home screen';
    const parts = [`Screenshot captured of ${label}${asRole ? ` as role "${asRole}"` : ''} at ${viewport} width (${shot.width}×${shot.height}).`];
    if (draftWrap.modelSupportsVision) {
        parts.push('The image follows — actually LOOK at it: rows whose spans wrapped past 12 columns, regions rendered empty because a binding returned no rows, charts with no bars, clipped or overlapping text, cramped spacing. Fix what is wrong before finalizing.');
    } else {
        parts.push('NOTE: your current model cannot see images, so the screenshot was shown to the user in the chat instead. Act on the diagnostics below, or ask the user what they see.');
    }
    if (shot.mountError) parts.push(`Mount error: ${shot.mountError}`);
    const pageErrors = Array.isArray(shot.pageErrors) ? shot.pageErrors : [];
    const consoleErrors = Array.isArray(shot.consoleErrors) ? shot.consoleErrors : [];
    if (pageErrors.length) parts.push(`Runtime errors (${pageErrors.length}):\n- ${pageErrors.join('\n- ')}`);
    if (consoleErrors.length) parts.push(`Console errors (${consoleErrors.length}):\n- ${consoleErrors.join('\n- ')}`);
    if (!shot.mountError && !pageErrors.length && !consoleErrors.length) parts.push('No render errors detected.');

    return {
        content: parts.join('\n\n'),
        _screenshotDataUrl: shot.dataUrl,
        _screenshotCaption: `Screenshot · ${rendered ? (rendered.name || rendered.id) : 'Home'}${asRole ? ` · as ${asRole}` : ''}${viewport !== 'desktop' ? ` · ${viewport}` : ''}`,
    };
}

// ── Read-only tools ──────────────────────────────────────────────────

const DRAFT_SECTIONS = new Set(['screens', 'actions', 'tables', 'meta']);

function applyGetDraft(draftWrap, args = {}) {
    // Lazy require — builderPrompt also requires componentSpecs; no cycle,
    // but keep the load cost off the module graph until first use.
    const { renderDraftState } = require('../builderPrompt');

    const screenId = typeof args?.screenId === 'string' && args.screenId ? args.screenId : null;
    // A screenId is a screens-only read by definition; asking for one screen and
    // getting the whole action list back is not what the caller meant.
    const section = screenId
        ? 'screens'
        : (DRAFT_SECTIONS.has(args?.section) ? args.section : null);

    if (!screenId && !section) return { draft: renderDraftState(draftWrap.def) };

    // The data block is only rendered when the caller asked for it — a plain
    // read keeps its historic shape, and the tables are injected each turn
    // anyway.
    const extras = section === 'tables'
        ? { dataModel: draftWrap.dataModel ?? null, datasets: draftWrap.datasetIds, rowCounts: draftWrap.rowCounts }
        : {};
    return { draft: renderDraftState(draftWrap.def, extras, { screenId, section }) };
}

// ── app_find_nodes ───────────────────────────────────────────────────

const MAX_FIND_HITS = 60;

/**
 * Search the draft instead of reading all of it.
 *
 * The walks this exposes already existed server-side (collectDataBindings for
 * the binding side, collectVariableRefs for variables) — they were simply
 * unreachable from a tool, so the only way to answer "where is this table used"
 * was to pull a 500-node tree and eyeball it. That is what makes a builder
 * delete a table and leave four dangling bindings behind.
 *
 * Read-only and total: an unknown id yields `hits: []` plus a note, never an
 * error, so a speculative check costs nothing.
 */
function applyFindNodes(draftWrap, args = {}) {
    const def = draftWrap.def || {};
    const componentType = typeof args?.componentType === 'string' ? args.componentType.trim() : '';
    const tableId = typeof args?.tableId === 'string' ? args.tableId.trim() : '';
    const actionId = typeof args?.actionId === 'string' ? args.actionId.trim() : '';
    const variable = typeof args?.variable === 'string' ? args.variable.trim() : '';
    const screenId = typeof args?.screenId === 'string' ? args.screenId.trim() : '';

    if (!componentType && !tableId && !actionId && !variable) {
        return {
            error: 'app_find_nodes needs at least one of componentType, tableId, actionId or variable.',
            _fixHint: 'Pass what you are looking for, e.g. { tableId: "tbl_x" } to find everything bound to that table.',
        };
    }
    if (componentType && !COMPONENT_SPECS[componentType]) {
        return {
            error: `Unknown component type "${componentType}".`,
            _fixHint: `Valid types: ${COMPONENT_TYPES.join(', ')}`,
        };
    }

    // A component matches a table when ANY of its bindings names it; the binding
    // walker already handles nesting (a stat's value, a list's item source).
    const bindingsByNode = new Map();
    if (tableId) {
        const { collectDataBindings } = require('../collectDataBindings');
        for (const { nodeId, prop, binding } of collectDataBindings(def, screenId || null)) {
            if (!nodeId || binding?.tableId !== tableId) continue;
            if (!bindingsByNode.has(nodeId)) bindingsByNode.set(nodeId, []);
            bindingsByNode.get(nodeId).push(prop);
        }
    }

    const hits = [];
    let truncated = false;
    const push = (hit) => {
        if (hits.length >= MAX_FIND_HITS) { truncated = true; return; }
        hits.push(hit);
    };

    const nodeMentionsVariable = (node) => {
        if (!variable) return false;
        // A variable is referenced as `vars.<name>` in formulas and templates,
        // wherever they sit on the node — so a raw scan of the node's own props
        // is both the simplest and the most complete test.
        let json;
        try { json = JSON.stringify(node.props ?? {}); } catch { return false; }
        return json.includes(`vars.${variable}`);
    };
    const nodeRunsAction = (node) => {
        if (!actionId) return false;
        return EVENT_NAMES.some((ev) => node[ev] === actionId);
    };

    const visit = (node, screen, path) => {
        if (!node || typeof node !== 'object') return;
        const here = [...path, node.type || 'node'];
        const reasons = [];
        if (componentType && node.type === componentType) reasons.push('type');
        if (tableId && bindingsByNode.has(node.id)) reasons.push(`bound via ${bindingsByNode.get(node.id).join(', ')}`);
        if (actionId && nodeRunsAction(node)) reasons.push('runs action');
        if (variable && nodeMentionsVariable(node)) reasons.push('reads variable');
        if (reasons.length) {
            push({
                kind: 'component',
                id: node.id,
                type: node.type,
                screenId: screen.id,
                screenName: screen.name || screen.id,
                path: here.join(' > '),
                why: reasons.join('; '),
            });
        }
        for (const child of Array.isArray(node.children) ? node.children : []) visit(child, screen, here);
    };

    for (const screen of def.screens || []) {
        if (!screen || typeof screen !== 'object') continue;
        if (screenId && screen.id !== screenId) continue;
        for (const section of screen.sections || []) {
            for (const node of (section && section.children) || []) visit(node, screen, [section.id]);
        }
    }

    // Actions are matched on their serialised form: a step's tableId, a target
    // variable and a nested action id all live in the same object graph, and a
    // structural walk per step kind would go stale the moment a kind is added.
    if (tableId || variable || actionId) {
        for (const [id, action] of Object.entries(def.actions || {})) {
            let json;
            try { json = JSON.stringify(action ?? {}); } catch { continue; }
            const reasons = [];
            if (tableId && json.includes(`"${tableId}"`)) reasons.push('touches table');
            if (variable && (json.includes(`vars.${variable}`) || json.includes(`"${variable}"`))) reasons.push('reads/writes variable');
            if (actionId && id === actionId) reasons.push('is this action');
            if (reasons.length) {
                push({ kind: 'action', id, type: action?.kind || 'sequence', why: reasons.join('; ') });
            }
        }
    }

    const note = hits.length
        ? (truncated ? `Showing the first ${MAX_FIND_HITS} matches — narrow the query with screenId.` : undefined)
        : 'Nothing in the draft matches. Safe to remove — or check the id, if you expected hits.';
    return { hits, hitCount: hits.length, ...(truncated ? { truncated: true } : {}), ...(note ? { note } : {}) };
}

// ── app_inspect_catalog ──────────────────────────────────────────────

/**
 * The full catalog entry of named component types and step kinds.
 *
 * The small band's system prompt carries the COMPACT catalog — one line per
 * type, the common step kinds only (builderPrompt/catalogRender.js) — so a
 * builder that reaches for a rarer prop (data_grid's groupBy, a kanban's
 * swimlanes, request_approval's whole field list) reads it here, in one
 * call, before it writes the entry. Names are answered by the same renderer
 * the full prompt uses, so there is one catalog, served two ways. Read-only,
 * total: an unknown name is answered with a did-you-mean, never an error
 * that costs the round — unless nothing at all was asked for.
 */
function applyInspectCatalog(args) {
    const names = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v.trim() ? [v] : []))
        .map((x) => String(x || '').trim()).filter(Boolean);
    const components = names(args?.components);
    const steps = names(args?.steps);
    if (!components.length && !steps.length) {
        return {
            error: 'Name at least one component type in `components` or one step kind in `steps`.',
            _fixHint: `e.g. { components: ["data_grid", "kanban"], steps: ["request_approval"] }. Types: ${COMPONENT_TYPES.join(', ')}. Step kinds: ${STEP_KINDS.join(', ')}.`,
        };
    }
    const { renderComponentEntry, renderStepEntry } = require('../builderPrompt/catalogRender');
    const out = { components: {}, steps: {} };
    const unknown = [];
    const skipped = [];
    const aliased = [];
    for (const [i, type] of components.entries()) {
        if (i >= INSPECT_CATALOG_MAX_COMPONENTS) { skipped.push(type); continue; }
        // The same reading app_add_components gives a name: "data grid" is
        // data_grid, "datatable" too. Answered under the real type — the
        // did-you-mean is for what does not resolve at all (before this,
        // "datatable" was steered to `table`, the static one, while the
        // add tool would have built a data_grid; caught in review 2026-09-18).
        const canon = canonicalComponentType(type) || type;
        const entry = renderComponentEntry(canon);
        if (entry) {
            out.components[canon] = entry;
            if (canon !== type) aliased.push(`"${type}" is ${canon}`);
            continue;
        }
        const near = pickClosestId(type, COMPONENT_TYPES);
        unknown.push(`${type} is not a component type${near ? ` — did you mean "${near}"?` : ''}`);
    }
    for (const [i, kind] of steps.entries()) {
        if (i >= INSPECT_CATALOG_MAX_STEPS) { skipped.push(kind); continue; }
        const entry = renderStepEntry(kind);
        if (entry) { out.steps[kind] = entry; continue; }
        const near = pickClosestId(kind, STEP_KINDS);
        unknown.push(`${kind} is not a step kind${near ? ` — did you mean "${near}"?` : ''}`);
    }
    if (!Object.keys(out.components).length) delete out.components;
    if (!Object.keys(out.steps).length) delete out.steps;
    if (aliased.length) out._hints = [`Read as the catalog's own type: ${aliased.join(', ')} — use the real type name in app_add_components.`];
    if (unknown.length) out.unknown = unknown;
    if (skipped.length) out.note = `Only the first ${INSPECT_CATALOG_MAX_COMPONENTS} component types and ${INSPECT_CATALOG_MAX_STEPS} step kinds per call are answered — ask again for: ${skipped.join(', ')}.`;
    return out;
}

/** Compact list row for one automation (shared by list + inspect). */
function automationSummaryRow(a) {
    const trigger = a?.definition?.trigger || {};
    const kind = trigger.kind || a.triggerType || 'manual';
    const row = {
        id: a.id,
        title: a.title,
        description: typeof a.description === 'string' ? a.description.slice(0, 200) : '',
        isActive: !!a.isActive,
        trigger: kind,
    };
    if (kind === 'agent_call') {
        const props = trigger.parametersSchema?.properties;
        row.params = props && typeof props === 'object' ? Object.keys(props) : [];
    }
    return row;
}

async function applyListAutomations(draftWrap) {
    const automationStore = require('../../stores/automationStore');
    let rows = [];
    try {
        rows = await automationStore.getAutomationsForUser(draftWrap.userId);
    } catch (e) {
        return { error: `Could not list the owner's routines: ${e.message}` };
    }
    const automations = (rows || []).slice(0, 100).map(automationSummaryRow);
    return {
        automations,
        note: automations.length
            ? 'Wire one via app_set_action { action: { kind:"run_automation", automationId:"<id>", inputMapping:{…} } }. `params` are the input names to map.'
            : 'The owner has no routines yet — run_automation actions can ship with automationId:null and be connected later.',
    };
}

async function applyInspectAutomation(draftWrap, args) {
    const automationId = typeof args?.automationId === 'string' ? args.automationId : null;
    if (!automationId) return { error: 'automationId is required.' };
    const automationStore = require('../../stores/automationStore');
    let a = null;
    try {
        a = await automationStore.getAutomation(automationId);
    } catch (e) {
        return { error: `Could not inspect the routine: ${e.message}` };
    }
    if (!a || a.userId !== draftWrap.userId) {
        return { error: `No routine "${automationId}" found for the app owner. Call app_list_automations for the real ids.` };
    }
    const row = automationSummaryRow(a);
    const trigger = a?.definition?.trigger || {};
    const detail = { ...row };
    if (trigger.kind === 'agent_call' && trigger.parametersSchema && typeof trigger.parametersSchema === 'object') {
        detail.parametersSchema = trigger.parametersSchema;
    } else if (trigger.kind === 'schedule' && trigger.schedule) {
        detail.schedule = trigger.schedule;
    }
    return { automation: detail };
}

module.exports = {
    applyDryRun,
    applyAppScreenshot,
    applyGetDraft,
    applyFindNodes,
    applyInspectCatalog,
    applyListAutomations,
    applyInspectAutomation,
    // internals re-exported through ../builderTools.js _test
    automationSummaryRow,
    MAX_SCREENSHOTS_PER_TURN,
};
