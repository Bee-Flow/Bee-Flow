/**
 * Human-readable diff between two automation definitions.
 *
 * Turns the raw JSON delta into plain phrases like "2 steps added",
 * "1 connection removed", "Description changed" — used both as the stored
 * per-version `change_summary` (automationStore) and, mirrored on the
 * frontend (Builder/diffSummary.js), as the primary content of the diff
 * modal. Keep the two implementations in sync by hand.
 *
 * Steps are matched by `id` (added / removed / changed); edges by their
 * from→to pair (added / removed); a handful of scalar/object fields are
 * reported as a single "X changed" phrase each. Order within `steps` /
 * `edges` is ignored — only membership and per-step content matter.
 */

function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
function plural(n, noun) { return `${n} ${noun}${n === 1 ? '' : 's'}`; }
function stableJson(v) {
    // Sorted-key stringify so a reordered-but-equal object isn't "changed".
    const sort = (x) => {
        if (Array.isArray(x)) return x.map(sort);
        if (x && typeof x === 'object') {
            const out = {};
            for (const k of Object.keys(x).sort()) out[k] = sort(x[k]);
            return out;
        }
        return x;
    };
    return JSON.stringify(sort(v ?? null));
}

function stepMap(def) {
    const m = new Map();
    for (const s of asArray(def.steps)) {
        if (s && s.id != null) m.set(String(s.id), s);
    }
    return m;
}
function edgeSet(def) {
    const s = new Set();
    for (const e of asArray(def.edges)) {
        if (e && e.from != null && e.to != null) s.add(`${e.from}→${e.to}`);
    }
    return s;
}

// Top-level definition fields surfaced as a single "X changed" phrase.
const FIELD_LABELS = [
    ['description', 'Description changed'],
    ['trigger', 'Trigger changed'],
    ['notificationSettings', 'Notification settings changed'],
    ['manualTriggerPayload', 'Manual trigger payload changed'],
    ['layers', 'Layers changed'],
];

/**
 * @returns {string[]} plain phrases describing prev → next (empty if equal)
 */
function summarizeDefinitionDiff(prevDef, nextDef) {
    const prev = asObject(prevDef);
    const next = asObject(nextDef);
    const phrases = [];

    // Steps (keyed by id)
    const prevSteps = stepMap(prev);
    const nextSteps = stepMap(next);
    let added = 0, removed = 0, changed = 0;
    for (const [id, s] of nextSteps) {
        if (!prevSteps.has(id)) added += 1;
        else if (stableJson(prevSteps.get(id)) !== stableJson(s)) changed += 1;
    }
    for (const id of prevSteps.keys()) if (!nextSteps.has(id)) removed += 1;
    if (added) phrases.push(`${plural(added, 'step')} added`);
    if (removed) phrases.push(`${plural(removed, 'step')} removed`);
    if (changed) phrases.push(`${plural(changed, 'step')} changed`);

    // Edges (connections)
    const prevEdges = edgeSet(prev);
    const nextEdges = edgeSet(next);
    let eAdded = 0, eRemoved = 0;
    for (const k of nextEdges) if (!prevEdges.has(k)) eAdded += 1;
    for (const k of prevEdges) if (!nextEdges.has(k)) eRemoved += 1;
    if (eAdded) phrases.push(`${plural(eAdded, 'connection')} added`);
    if (eRemoved) phrases.push(`${plural(eRemoved, 'connection')} removed`);

    // Scalar / object fields
    for (const [field, label] of FIELD_LABELS) {
        if (stableJson(prev[field]) !== stableJson(next[field])) phrases.push(label);
    }

    return phrases;
}

/**
 * One-line summary, e.g. "2 steps added · 1 connection removed".
 * Falls back to a "formatting only" note when nothing structural changed.
 */
function summarizeDefinitionDiffLine(prevDef, nextDef) {
    const phrases = summarizeDefinitionDiff(prevDef, nextDef);
    // Keep this string identical to the FE mirror (agent-hub Builder/
    // diffSummary.js) — the two are hand-synced ("mirrored verbatim"), and a
    // drift here means the stored change_summary reads differently from the
    // diff modal for the same no-op version.
    return phrases.length ? phrases.join(' · ') : 'No structural changes (formatting only)';
}

// Handoff 5 (artboard 5d): the per-field diff, the plain-language version
// description and the layout-only test live in fieldDiff.js; re-exported here
// so the version writer reads every "what changed" answer from one module.
const { fieldDiff, describeChange, describeVersion, describeText, isLayoutOnlyChange, stepIdsOf } = require('./fieldDiff');
const { SETTINGS_KEYS } = require('../core/automationRunner/definitionForRun');

/** The definition without its SETTINGS keys (notificationSettings, runPolicy). */
function withoutSettings(def) {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return def;
    const out = { ...def };
    for (const k of SETTINGS_KEYS) delete out[k];
    return out;
}

/**
 * True when prev → next differs in SETTINGS (and possibly layout), nothing
 * else. Settings apply to live runs without a publish (definitionForRun.js),
 * so such a save is not a pending change.
 */
function isSettingsOnlyChange(prevDef, nextDef) {
    if (isLayoutOnlyChange(prevDef, nextDef)) return false;
    return isLayoutOnlyChange(withoutSettings(prevDef), withoutSettings(nextDef));
}

const SETTINGS_CHANGED = Object.freeze([{ code: 'settings_changed', params: {} }]);

/**
 * What a definition write should do about versions (stores/automationStore/
 * automations.js reads this inside its transaction).
 *
 *   - a LAYOUT-ONLY write (positions, sizes, colours, icons; or nothing at
 *     all) creates no version: the working copy is updated in place and the
 *     next structural save's version carries the positions;
 *   - `forceVersion` (a restore) writes one anyway, marked is_layout_only when
 *     that is all it changed, so it never counts as a pending change;
 *   - a SETTINGS-ONLY write (notificationSettings, runPolicy, plus
 *     layout at most) writes a version described "Settings changed" and marked
 *     is_layout_only: settings already apply to live runs, so there is
 *     nothing to publish (core/automationRunner/definitionForRun.js);
 *   - otherwise the version gets the plain-language description of the change,
 *     unless the caller brings its own (`versionMeta`: a restore says
 *     "Restored from v3", a template "Created from template ...").
 *
 * Never throws: a description that cannot be built leaves the row without
 * one, and a diff that cannot be computed counts as structural.
 *
 * @param {object} prevDef
 * @param {object} nextDef
 * @param {{ versionMeta?: { name?: string|null, description?: string|null, descriptionJson?: any, isLayoutOnly?: boolean }|null,
 *           forceVersion?: boolean }} [opts]
 * @returns {{ createVersion: boolean, isLayoutOnly: boolean, name: string|null, description: string|null,
 *             descriptionJson: any, changeSummary: string|null }}
 */
function planVersionWrite(prevDef, nextDef, { versionMeta = null, forceVersion = false } = {}) {
    const meta = versionMeta || {};
    let desc = null;
    try { desc = describeVersion(prevDef, nextDef); }
    catch (_) { desc = null; }
    const layoutOnly = !!desc?.layoutOnly;
    let settingsOnly = false;
    if (desc && !layoutOnly) {
        try { settingsOnly = isSettingsOnlyChange(prevDef, nextDef); }
        catch (_) { settingsOnly = false; }
    }
    let changeSummary = null;
    try { changeSummary = summarizeDefinitionDiffLine(prevDef, nextDef); }
    catch (_) { /* best-effort, like the description */ }
    const ownEntries = settingsOnly ? SETTINGS_CHANGED.map(e => ({ ...e, params: {} })) : (desc?.entries || []);
    const descriptionJson = meta.descriptionJson != null
        ? meta.descriptionJson
        : (ownEntries.length ? ownEntries : null);
    const description = meta.description
        || (meta.descriptionJson != null ? describeText(Array.isArray(meta.descriptionJson) ? meta.descriptionJson : [meta.descriptionJson]) : null)
        || (settingsOnly ? describeText(ownEntries) : desc?.text)
        || null;
    return {
        createVersion: !layoutOnly || !!forceVersion,
        isLayoutOnly: meta.isLayoutOnly != null ? !!meta.isLayoutOnly : (layoutOnly || settingsOnly),
        name: typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : null,
        description,
        descriptionJson,
        changeSummary,
    };
}

module.exports = {
    summarizeDefinitionDiff,
    summarizeDefinitionDiffLine,
    fieldDiff,
    describeChange,
    describeVersion,
    describeText,
    isLayoutOnlyChange,
    isSettingsOnlyChange,
    stepIdsOf,
    planVersionWrite,
};
