// @typecheck
/**
 * builder_remove_step — remove a step and bridge its edges, and
 * findDanglingRefs: which surviving steps still read the removed id. Moved
 * verbatim out of stepEditing.js.
 */

const { BRANCHING_TYPES, listStepIds, findStepAnywhere } = require('../draftGraph');

/**
 * Which surviving steps still reference `id` in a binding.
 *
 * applyRemoveStep reports the bridged edges and also every
 * `steps.<id>.output.*` binding left in the rest of the graph
 * pointing at a step that no longer exists. Left unreported, the breakage only surfaces a
 * ROUND later, as a ref.unknown_step validation error, by which time the model
 * has usually moved on and has to backtrack. Reporting it in the result of the
 * call that caused it is what lets the model fix it immediately.
 *
 * Warn rather than refuse: removing a step and re-pointing its consumers is a
 * legitimate two-step edit, and applyRemoveTrigger already set the
 * report-don't-block precedent for orphans.
 */
function findDanglingRefs(graph, id) {
    const { collectRefPaths, isObject } = require('../../validate/helpers');
    const { collectStepRefs } = require('../../validate/stepRules/refSurfaces');
    const { refHead, tryParseExpr, exprStepIds, findRefPaths } = require('../../validate/refPaths');
    const { TOPIC_HOST_SPEC } = require('../../expr');
    // One reference, read the way the runner reads it: a path by the shared
    // grammar (dotted or bracketed id, never a prefix match), an expression
    // by its parser (a quoted "read" is a value). A half-typed expression is
    // still searched for the paths in it, so a typo does not hide a read.
    const readsId = (/** @type {{ kind: string; path: string; src: string; }} */ r) => {
        if (r.kind === 'ref') {
            const h = refHead(r.path);
            return h.root === 'steps' && h.second === id;
        }
        const { ast } = tryParseExpr(r.src, { host: TOPIC_HOST_SPEC });
        if (ast) return exprStepIds(ast).includes(id);
        return findRefPaths(r.src, ['steps']).some(t => t[1].type === 'prop' && String(t[1].key) === id);
    };
    // Every reference a step carries: binding objects anywhere in it, plus the
    // surfaces that hold bare paths, templates and expressions (refSurfaces.js,
    // the validator's list), for the step and every step nested in it.
    const refsOf = (s) => {
        const out = [];
        collectRefPaths(s, out);
        const walk = (st) => {
            if (!isObject(st)) return;
            out.push(...collectStepRefs(st));
            for (const child of (Array.isArray(st.body) ? st.body : [])) walk(child);
            for (const b of (Array.isArray(st.branches) ? st.branches : [])) {
                for (const child of (Array.isArray(b) ? b : (Array.isArray(b?.steps) ? b.steps : []))) walk(child);
            }
        };
        walk(s);
        return out;
    };
    const hits = new Set();
    /**
     * @param {string | null} scope
     */
    const scan = (steps, scope) => {
        for (const s of (steps || [])) {
            if (!s || s.id === id) continue;
            if (refsOf(s).some(readsId)) hits.add(scope ? `${scope}/${s.id}` : s.id);
        }
    };
    scan(graph?.steps, null);
    for (const [key, g] of Object.entries(graph?.layers || {})) {
        if (g && typeof g === 'object') scan(g.steps, key);
    }
    return [...hits];
}

function applyRemoveStep(graph, args) {
    const id = args.stepId;
    // Trigger ids: the primary is never removable here (builder_propose_trigger
    // replaces it); an ADDITIONAL trigger is removed with its outgoing edges.
    if (graph?.trigger && id === graph.trigger.id) {
        return { error: 'The primary trigger cannot be removed — change it with builder_propose_trigger.' };
    }
    if (Array.isArray(graph?.triggers) && graph.triggers.some(t => t && t.id === id)) {
        return require('../triggers').applyRemoveTrigger(graph, id);
    }
    const found = findStepAnywhere(graph, id);
    if (!found) return { error: `Unknown stepId "${id}". Existing step ids: ${listStepIds(graph)}.` };

    // Loop-body steps have no top-level edges — just splice them out.
    if (found.kind === 'loop') {
        const dangling = findDanglingRefs(graph, id);
        found.container.splice(found.index, 1);
        return { removed: id, ...(dangling.length ? { danglingRefs: dangling, note: `steps ${dangling.join(', ')} still bind steps.${id}.* — re-point or remove those bindings` } : {}) };
    }

    const reconnect = args.reconnect !== false;   // default true
    const step = found.step;
    // Collected BEFORE the splice — afterwards the step is gone and its
    // consumers are indistinguishable from consumers of a never-existing id.
    const dangling = findDanglingRefs(graph, id);
    const incoming = (graph.edges || []).filter(e => e.to === id);
    const outgoing = (graph.edges || []).filter(e => e.from === id);
    /** @type {string[]} */
    const bridges = [];

    if (reconnect && incoming.length && outgoing.length) {
        const branching = BRANCHING_TYPES.has(step.type);
        // Successor targets to bridge to: prefer the success path (skip on_error).
        let targets;
        if (!branching) {
            const succ = outgoing.filter(e => e.label !== 'on_error').map(e => e.to);
            targets = succ.length ? succ : outgoing.map(e => e.to);
        } else {
            // Branching anchor: pick a single primary successor; the rest are dropped.
            const primary = outgoing.find(e => e.label === 'then')
                || outgoing.find(e => e.label === 'case:default')
                || outgoing.find(e => e.label !== 'on_error')
                || outgoing[0];
            targets = primary ? [primary.to] : [];
        }
        for (const inc of incoming) {
            for (const to of targets) {
                if (inc.from === to) continue;
                const e = { from: inc.from, to };
                if (inc.label) { e.label = inc.label; if (inc.caseName) e.caseName = inc.caseName; }
                const dup = (graph.edges || []).some(x => x.from === e.from && x.to === e.to && x.label === e.label);
                if (!dup) { graph.edges.push(e); bridges.push(`${e.from}→${e.to}`); }
            }
        }
    }

    found.container.splice(found.index, 1);
    graph.edges = graph.edges.filter(e => e.from !== id && e.to !== id);

    /** @type {string[]} */
    const parts = [];
    if (bridges.length) parts.push(`reconnected ${bridges.join(', ')}`);
    if (dangling.length) parts.push(`steps ${dangling.join(', ')} still bind steps.${id}.* — re-point or remove those bindings`);
    if (reconnect && BRANCHING_TYPES.has(step.type) && outgoing.filter(e => e.label !== 'on_error').length > 1) {
        parts.push('removed a branching step — only its primary branch was reconnected; re-wire the other branch targets if still needed');
    }
    return {
        removed: id,
        ...(dangling.length ? { danglingRefs: dangling } : {}),
        ...(parts.length ? { note: parts.join('; ') } : {}),
    };
}

module.exports = { findDanglingRefs, applyRemoveStep };

/** @typedef {import('../draftGraph').DraftGraph & { triggers?: Array<{ id?: string }> }} RemovableGraph */

/** @typedef {import('../draftGraph').GraphEdge} GraphEdge */
