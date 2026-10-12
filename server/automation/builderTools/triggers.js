/**
 * Builder tools — ADDITIONAL triggers (`definition.triggers[]`).
 *
 * An automation has one PRIMARY trigger (`definition.trigger`, minted by
 * builder_propose_trigger with the fixed id 'trg') and may declare extra
 * entry points. Each extra trigger is its own DAG root: the dispatcher seeds
 * the run from the node that fired (`rootStepId`), and the steps wired out of
 * it run. Until now only the canvas could add one; the AI/MCP builder could
 * neither add, edit nor remove them — and re-calling builder_propose_trigger
 * silently REPLACED the primary instead. These three tools close that gap.
 *
 * Which kinds may be secondary is the validator's decision
 * (validate/constants.js SECONDARY_TRIGGER_KINDS): webhook and app_event
 * carry their own storage rows, schedule got its own table in 2026-09;
 * manual / form / agent_call / app_trigger stay primary-only.
 */

const { newId } = require('./draftGraph');
const { SECONDARY_TRIGGER_KINDS } = require('../validate/constants');
const { DEFAULT_SCHEDULE_TZ } = require('../triggerColumns');
const { agentCallFieldsFrom } = require('../agentCallContract');
const { buildForm, buildAppParams, agentCallIssueLines, NO_ARGS_WARNING, triggerHints } = require('./stepBuilders/triggerApply');

const MAX_LABEL = 80;

function cleanLabel(label) {
    return (typeof label === 'string' && label.trim()) ? label.trim().slice(0, MAX_LABEL) : null;
}

function defaultLabel(kind, args = {}) {
    if (kind === 'app_event') return `${args.appProvider || 'app'} · ${args.appEvent || 'event'}`;
    if (kind === 'schedule') return `Schedule ${args.cron || ''}`.trim();
    if (kind === 'webhook') return 'Webhook';
    return kind;
}

/**
 * The node shape for a webhook / app_event / schedule trigger — the same
 * fields builder_propose_trigger writes for the primary (stepBuilders.js
 * applyTrigger), so a secondary trigger is indistinguishable from a primary
 * one to the validator, the canvas and the dispatcher.
 */
function buildTriggerNode(kind, args = {}, { id, label = null } = {}) {
    const node = { id, type: 'trigger', kind, output: {} };
    if (kind === 'schedule') node.schedule = { cron: args.cron, tz: args.tz || DEFAULT_SCHEDULE_TZ };
    if (kind === 'webhook') node.webhook = {};
    if (kind === 'app_event') node.appEvent = { provider: args.appProvider, event: args.appEvent, filter: args.filter || null };
    const l = cleanLabel(label);
    if (l) node.label = l;
    return node;
}

function allTriggers(draft) {
    return [draft?.trigger, ...(Array.isArray(draft?.triggers) ? draft.triggers : [])].filter(t => t && typeof t === 'object');
}

function listTriggers(draft) {
    return allTriggers(draft).map(t => `${t.id}(${t.kind}${t.appEvent ? `:${t.appEvent.provider}.${t.appEvent.event}` : ''}${t.schedule?.cron ? `:${t.schedule.cron}` : ''})`).join(', ') || '(none)';
}

function kindArgsError(kind, args) {
    if (kind === 'app_event' && (!args.appProvider || !args.appEvent)) {
        return 'An app_event trigger needs appProvider and appEvent (see the trigger catalog in the guide).';
    }
    if (kind === 'schedule' && (typeof args.cron !== 'string' || !args.cron.trim())) {
        return 'A schedule trigger needs a 5-field cron ("minute hour day-of-month month day-of-week"), optionally with tz.';
    }
    return null;
}

/** builder_add_trigger */
function applyAddTrigger(draft, args = {}) {
    if (draft?.trigger?.kind === 'layer_input') {
        return { error: 'A flowlet (or reusable Step) cannot have additional triggers — only the automation root can. Drop the scope and add the trigger to the main flow.' };
    }
    if (!draft?.trigger) {
        return { error: 'Set the primary trigger first with builder_propose_trigger; additional triggers come after it.' };
    }
    const kind = args.kind;
    if (!SECONDARY_TRIGGER_KINDS.has(kind)) {
        return { error: `kind "${kind}" cannot be an additional trigger. Allowed: ${[...SECONDARY_TRIGGER_KINDS].join(', ')}. manual, form, agent_call and app_trigger can only be the ONE primary trigger (builder_propose_trigger).` };
    }
    const argErr = kindArgsError(kind, args);
    if (argErr) return { error: argErr };

    const node = buildTriggerNode(kind, args, { id: newId('trig'), label: args.label || defaultLabel(kind, args) });
    draft.triggers = Array.isArray(draft.triggers) ? draft.triggers : [];
    draft.triggers.push(node);
    return {
        added: node,
        next: `Wire this trigger's first step with afterStepId: "${node.id}" (an omitted afterStepId chains after the LAST step, never after a new trigger). Test it with builder_request_dry_run({triggerStepId: "${node.id}", …}).`,
    };
}

// The patch keys each kind accepts beside `label`. Anything else is reported
// back as ignored, so a typo is not mistaken for an edit that landed.
const PATCH_KEYS = Object.freeze({
    app_event: ['appProvider', 'appEvent', 'filter'],
    schedule: ['cron', 'tz'],
    agent_call: ['toolName', 'description', 'parametersSchema', 'params'],
    form: ['form'],
    app_trigger: ['params'],
});

/** The form keys a patch may carry; each one present replaces that key of the stored form. */
function patchForm(node, patchedForm) {
    if (!patchedForm || typeof patchedForm !== 'object' || Array.isArray(patchedForm)) return null;
    const built = buildForm(patchedForm);
    const merged = node.form && typeof node.form === 'object' ? { ...node.form } : buildForm({});
    const touched = [];
    for (const key of Object.keys(patchedForm)) {
        if (!(key in built)) continue;
        merged[key] = built[key];
        touched.push(key);
    }
    return { merged, touched };
}

/** builder_update_trigger — edits a filter / cron / label / declared inputs in place; works on the primary too. */
function applyUpdateTrigger(draft, args = {}) {
    const id = typeof args.triggerId === 'string' ? args.triggerId : '';
    const node = allTriggers(draft).find(t => t.id === id);
    if (!node) return { error: `Unknown triggerId "${id}". Triggers: ${listTriggers(draft)}.` };
    const patch = args.patch && typeof args.patch === 'object' ? args.patch : {};
    if (patch.kind !== undefined && patch.kind !== node.kind) {
        return { error: 'A trigger cannot change kind in place — remove it and add a new one (or builder_propose_trigger for the primary).' };
    }
    const changed = [];
    const warnings = [];
    if (patch.label !== undefined) {
        const l = cleanLabel(patch.label);
        if (l) node.label = l; else delete node.label;
        changed.push('label');
    }
    if (node.kind === 'app_event') {
        node.appEvent = node.appEvent && typeof node.appEvent === 'object' ? node.appEvent : { provider: null, event: null, filter: null };
        if (patch.appProvider !== undefined) { node.appEvent.provider = patch.appProvider; changed.push('appProvider'); }
        if (patch.appEvent !== undefined) { node.appEvent.event = patch.appEvent; changed.push('appEvent'); }
        if (patch.filter !== undefined) { node.appEvent.filter = patch.filter || null; changed.push('filter'); }
    } else if (node.kind === 'schedule') {
        node.schedule = node.schedule && typeof node.schedule === 'object' ? node.schedule : {};
        if (patch.cron !== undefined) { node.schedule.cron = patch.cron; changed.push('cron'); }
        if (patch.tz !== undefined) { node.schedule.tz = patch.tz || DEFAULT_SCHEDULE_TZ; changed.push('tz'); }
    } else if (node.kind === 'agent_call') {
        // Only what the patch names is touched: the other two declarations stay.
        const { fields, notes } = agentCallFieldsFrom(patch);
        for (const [key, value] of Object.entries(fields)) {
            if (value === null) delete node[key]; else node[key] = value;
            changed.push(key);
        }
        warnings.push(...notes);
        if (changed.some(k => k === 'parametersSchema' || k === 'description' || k === 'toolName')) {
            if (!node.parametersSchema) warnings.push(NO_ARGS_WARNING);
            warnings.push(...agentCallIssueLines(node));
        }
    } else if (node.kind === 'form' && patch.form !== undefined) {
        const r = patchForm(node, patch.form);
        if (r) { node.form = r.merged; changed.push(...r.touched.map(k => `form.${k}`)); }
        else warnings.push('patch.form must be an object with any of title, description, submitLabel, successMessage, collect, fields; nothing changed.');
    } else if (node.kind === 'app_trigger' && patch.params !== undefined) {
        if (Array.isArray(patch.params)) { node.params = buildAppParams(patch.params); changed.push('params'); }
        else warnings.push('patch.params must be a list of {name, type, required, description}; nothing changed.');
    }
    const allowed = new Set(['label', 'kind', ...(PATCH_KEYS[node.kind] || [])]);
    const ignored = Object.keys(patch).filter(k => !allowed.has(k));
    const lines = [...(ignored.length ? [`ignored patch keys for a ${node.kind} trigger: ${ignored.join(', ')}`] : []), ...warnings];
    return {
        updated: node,
        changed,
        ...(lines.length ? { _warnings: lines } : {}),
        ...triggerHints(node),
    };
}

/**
 * Remove an ADDITIONAL trigger and its outgoing edges. Steps that were only
 * reachable from it are reported as `orphaned` (they stay in the draft — the
 * author may re-wire them — but the validator will flag them as unreachable).
 */
function applyRemoveTrigger(draft, id) {
    if (draft?.trigger && id === draft.trigger.id) {
        return { error: 'The primary trigger cannot be removed — change it with builder_propose_trigger.' };
    }
    const list = Array.isArray(draft?.triggers) ? draft.triggers : [];
    const idx = list.findIndex(t => t && t.id === id);
    if (idx < 0) return { error: `Unknown triggerId "${id}". Triggers: ${listTriggers(draft)}.` };
    const edges = Array.isArray(draft.edges) ? draft.edges : [];
    const targets = edges.filter(e => e && e.from === id).map(e => e.to);
    list.splice(idx, 1);
    if (list.length === 0) delete draft.triggers;
    draft.edges = edges.filter(e => e && e.from !== id && e.to !== id);
    const orphaned = [...new Set(targets)].filter(to => !draft.edges.some(e => e.to === to));
    return { removed: id, ...(orphaned.length ? { orphaned, note: `steps ${orphaned.join(', ')} no longer have an incoming edge — wire them from another trigger/step or remove them` } : {}) };
}

module.exports = { buildTriggerNode, applyAddTrigger, applyUpdateTrigger, applyRemoveTrigger, allTriggers, defaultLabel };
