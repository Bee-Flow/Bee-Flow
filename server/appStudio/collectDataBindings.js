/**
 * App Studio — SHARED server-side data-binding collector.
 *
 * Walks a definition's screens → sections → nodes and returns every data
 * binding (kinds record / records / dataset) a component reads, tagged with
 * the node id and the top-level prop it hangs off:
 *
 *   collectDataBindings(def, screenId?) → [{ nodeId, prop, binding }]
 *
 * This mirrors the CLIENT collector (agent-hub runtime AppDataScope.collectDataBindings,
 * which returns { cacheKey, binding }) but is the single SERVER-side
 * implementation — the same "one engine, two runtimes" precedent as @shared/expr.
 * The server dry-run (appDryRun.js) consumes it; a future wave can converge the
 * client onto it too. Keeping it in its own module means appDryRun does NOT
 * re-implement a third copy of the walk.
 *
 * Pure and defensive: malformed nodes are skipped, never thrown on. A data
 * binding's own fields are not descended into (a filter's formula value is not
 * itself a fetched data binding).
 */

'use strict';

const DATA_BINDING_KINDS = new Set(['record', 'records', 'aggregate', 'dataset']);

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** A stable-ish fingerprint of a binding for de-duplication within one (node, prop). */
function bindingFingerprint(binding) {
    try { return JSON.stringify(binding); } catch { return String(binding && binding.kind); }
}

/**
 * Collect every record/records/dataset binding on the target screen(s).
 *
 * @param {object} def       — a canonical app definition
 * @param {string} [screenId]— when given, only that screen is walked; otherwise
 *                             every screen. An unknown id yields no bindings.
 * @returns {Array<{nodeId:string|null, prop:string, binding:object}>}
 */
function collectDataBindings(def, screenId = null) {
    const screens = (def && Array.isArray(def.screens)) ? def.screens : [];
    const targetScreens = screenId
        ? screens.filter((s) => isPlainObject(s) && s.id === screenId)
        : screens;

    const out = [];
    const seen = new Set();

    const pushBinding = (nodeId, prop, binding) => {
        const key = `${nodeId}\u0000${prop}\u0000${bindingFingerprint(binding)}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ nodeId, prop, binding });
    };

    // Deep-scan one prop value for data bindings (a binding can sit directly on
    // the prop, or nested inside an array/object the prop holds — e.g. a stat's
    // value, a list item source).
    const visitValue = (nodeId, prop, value) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) {
            for (const v of value) visitValue(nodeId, prop, v);
            return;
        }
        if (typeof value.kind === 'string' && DATA_BINDING_KINDS.has(value.kind)) {
            pushBinding(nodeId, prop, value);
            return; // a binding's own fields never hold nested fetched bindings
        }
        for (const v of Object.values(value)) visitValue(nodeId, prop, v);
    };

    const visitNode = (node) => {
        if (!isPlainObject(node)) return;
        const nodeId = typeof node.id === 'string' ? node.id : null;
        const props = isPlainObject(node.props) ? node.props : {};
        for (const [prop, value] of Object.entries(props)) {
            visitValue(nodeId, prop, value);
        }
        for (const child of Array.isArray(node.children) ? node.children : []) visitNode(child);
    };

    for (const screen of targetScreens) {
        if (!isPlainObject(screen)) continue;
        for (const section of Array.isArray(screen.sections) ? screen.sections : []) {
            if (!isPlainObject(section)) continue;
            for (const node of Array.isArray(section.children) ? section.children : []) visitNode(node);
        }
    }
    return out;
}

module.exports = { collectDataBindings, DATA_BINDING_KINDS };
