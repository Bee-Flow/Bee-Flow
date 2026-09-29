import { nodeTypeLabel } from './nodeDefs';
import { originKeysFor } from './ribbonOrigin';
import { INTEGRATION_META, resolveIntegrationFromTool } from '../../../../utils/integrationIcons';

/**
 * The card being drawn — the pure half of the ghost slot's "typing" state
 * (the stateful half is useBuildChoreography.js, the look GhostStepNode.jsx).
 *
 * While the model streams a tool call's arguments the server scans the partial
 * JSON and sends what it can already read (`tool_draft`, see
 * hooks/useAutomationBuilderStream.js → state.toolDraft). This module turns
 * that into what the ghost slot can SHOW: for an add/replace/update the last
 * step recognised so far — its app, kind, name-in-progress and place in the
 * batch; for an inspect the app being looked at; for the other builder tools
 * one line saying what is happening. Nothing here touches the DOM or React,
 * so it is testable as a table.
 *
 * `t` is optional: without one the English lines are used, interpolated the
 * same way (a pure helper, a test).
 */

/** Builder tools that write step objects; the last one in `steps` is the card being typed. */
const STEP_TOOL_RX = /^builder_(add_\w+|replace_step|update_steps?)$/;

/** Tools that are an activity, not a card: one caption each. */
const ACTIVITY_CAPTIONS = Object.freeze({
    builder_request_dry_run: ['testing', 'Running a test…'],
    builder_set_plan: ['planning', 'Writing the plan…'],
    builder_summarise: ['summarising', 'Summarising the routine…'],
    builder_summarize: ['summarising', 'Summarising the routine…'],
    builder_finalize: ['finalizing', 'Saving the routine…'],
    builder_finalise: ['finalizing', 'Saving the routine…'],
    builder_wire_error_branch: ['wiring', 'Wiring the error branch…'],
    builder_remove_step: ['editing', 'Adjusting a step…'],
    builder_remove_steps: ['editing', 'Adjusting a step…'],
});

const K = 'routines.canvas.draft';

/** `{app}` → the value, literally (never a replacement pattern — see useTranslation.interpolate). */
function fill(text, params) {
    if (!params) return text;
    let out = text;
    for (const [k, v] of Object.entries(params)) {
        const literal = String(v);
        out = out.replace(new RegExp(`\\{${k}\\}`, 'g'), () => literal);
    }
    return out;
}

function tr(t, key, english, params) {
    if (typeof t === 'function') {
        const out = t(`${K}.${key}`, english, params);
        return typeof out === 'string' && out ? out : fill(english, params);
    }
    return fill(english, params);
}

const normalizeId = (id) => String(id || '').replace(/-/g, '_').toLowerCase();

/** "google_calendar" → "Google calendar": the last resort when nobody knows the app's name. */
function prettify(id) {
    const s = String(id || '').replace(/[_-]+/g, ' ').trim();
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

/**
 * The app behind a tool name: `{ id, name }` or null. The catalog is asked
 * first — it lists every action by tool name, so an app the prefix resolver
 * does not know (an MCP server, a new connector) is still found — then the
 * prefix resolver, then INTEGRATION_META for a display name.
 */
export function appForTool(tool, catalog = null) {
    if (typeof tool !== 'string' || !tool) return null;
    const resolved = resolveIntegrationFromTool(tool);
    const apps = Array.isArray(catalog?.apps) ? catalog.apps : [];
    let owner = apps.find(a => Array.isArray(a?.actions) && a.actions.some(act => act?.name === tool)) || null;
    if (!owner && resolved) {
        const want = normalizeId(resolved);
        owner = apps.find(a => normalizeId(a?.id) === want) || null;
    }
    const id = resolved || owner?.id || null;
    if (!id) return null;
    const name = owner?.label || INTEGRATION_META[normalizeId(id)]?.label || INTEGRATION_META[id]?.label || prettify(id);
    return { id: String(id), name };
}

function stepDraft(toolDraft, name, { catalog, t }) {
    const steps = Array.isArray(toolDraft.steps) ? toolDraft.steps : [];
    const last = steps.length ? steps[steps.length - 1] : null;
    if (!last) {
        // The call has opened but no step object is readable yet. An add is
        // going to place a card; the others adjust one that exists.
        const adding = /^builder_add_/.test(name);
        return {
            kind: adding ? 'step' : 'editing',
            app: null, tool: null, type: null, typeLabel: null, label: null, partial: true,
            index: 0, count: 0, stepOf: null,
            caption: adding ? tr(t, 'typing', 'Writing the next step…') : tr(t, 'editing', 'Adjusting a step…'),
        };
    }
    const tool = typeof last.tool === 'string' && last.tool ? last.tool : null;
    // The server's scanner reports the SHORTHAND type for a lone app step
    // ('action', from builder_add_action); the canvas only knows the engine
    // type. Everything else arrives as the engine type already.
    const rawType = typeof last.type === 'string' && last.type ? last.type : null;
    const type = rawType === 'action' ? 'integration_action' : rawType;
    const app = appForTool(tool, catalog);
    const label = typeof last.label === 'string' && last.label.trim() ? last.label.trim() : null;
    const count = Number.isFinite(toolDraft.count) ? toolDraft.count : steps.length;
    const index = steps.length;
    // The server's scan stops at 40 cards. When it does, `count` is that
    // ceiling and index has caught up with it, so "Step 40 of 40" was printed
    // for a batch whose real size nobody knows yet — an answer to a question
    // the user never asked. Capped means: show where we are, not a total.
    const capped = toolDraft.capped === true;
    const typeLabel = type ? (nodeTypeLabel(type, t) || null) : null;
    const caption = label
        || (app ? tr(t, 'placing', 'Placing {app}…', { app: app.name }) : tr(t, 'typing', 'Writing the next step…'));
    return {
        kind: 'step',
        app, tool, type, typeLabel, label,
        partial: last.partial !== false,
        index, count,
        stepOf: capped
            ? tr(t, 'step_from', 'Step {i}+', { i: index })
            : (count > 1 ? tr(t, 'step_of', 'Step {i} of {n}', { i: index, n: count }) : null),
        caption,
    };
}

function inspectDraft(toolDraft, { catalog, t }) {
    const tools = (Array.isArray(toolDraft.inspect) ? toolDraft.inspect : []).filter(x => typeof x === 'string' && x);
    if (!tools.length) return null;
    const tool = tools[tools.length - 1];
    const app = appForTool(tool, catalog);
    const caption = tools.length >= 2
        ? tr(t, 'inspecting_many', 'Looking at {n} apps…', { n: tools.length })
        : tr(t, 'inspecting', 'Looking at {app}…', { app: app?.name || prettify(tool) });
    return {
        kind: 'inspect',
        app, tool, type: null, typeLabel: null, label: null, partial: true,
        index: tools.length, count: tools.length, stepOf: null,
        caption,
    };
}

/**
 * toolDraft → what the ghost slot shows, or null when there is nothing to
 * say (no draft, an unknown tool, an inspect with no tool read yet) — the
 * slot then keeps its usual caption.
 *
 * @returns {null | { kind: 'step'|'inspect'|'testing'|'planning'|'summarising'|'finalizing'|'wiring'|'editing',
 *   app: {id, name}|null, tool: string|null, type: string|null, typeLabel: string|null,
 *   label: string|null, partial: boolean, index: number, count: number, stepOf: string|null, caption: string }}
 */
export function projectGhostDraft(toolDraft, { catalog = null, t = null } = {}) {
    const name = typeof toolDraft?.name === 'string' ? toolDraft.name : null;
    if (!name) return null;
    if (STEP_TOOL_RX.test(name)) return stepDraft(toolDraft, name, { catalog, t });
    if (name === 'builder_inspect_tool') return inspectDraft(toolDraft, { catalog, t });
    const activity = ACTIVITY_CAPTIONS[name];
    if (!activity) return null;
    const [kind, english] = activity;
    return {
        kind,
        app: null, tool: null, type: null, typeLabel: null, label: null, partial: true,
        index: 0, count: 0, stepOf: null,
        caption: tr(t, kind, english),
    };
}

/**
 * The ribbon tiles the spotlight (useRibbonSpotlight) may rest on for a
 * draft: the app's own command, the "n more" that folds it, or the category
 * pill the whole category collapsed into — never the tab strip or the whole
 * ribbon, which the flight's ladder falls back to. Those always resolve, so
 * a spotlight on them would never wait for the Apps tab to mount, and a ring
 * around the entire ribbon for ten seconds is not an "eye on this tile".
 * Empty when the draft has no app.
 */
export function spotlightKeysFor(draft, catalog = null) {
    if (!draft || !draft.tool || !draft.app) return [];
    if (draft.kind !== 'step' && draft.kind !== 'inspect') return [];
    return originKeysFor({ type: 'integration_action', tool: draft.tool, appId: draft.app.id }, catalog)
        .filter(k => k.startsWith('app:') || k.startsWith('more:') || k.startsWith('cat:'));
}
