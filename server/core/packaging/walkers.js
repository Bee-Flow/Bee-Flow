/**
 * The definition walkers the packaging sweeps (scrub, pointers) share with the
 * features whose documents they read: `walkObjects` for an App Studio
 * definition (every object, depth-first) and `walkAllSteps` for an automation
 * definition (every node of every graph, triggers included).
 *
 * They lived in appStudio/templateCapture.js and automation/portability.js,
 * which both call INTO packaging/scrub.js, so the scrub could only reach them
 * through a lazy require: a three-way cycle between projects/, appStudio/ and
 * automation/. A leaf in core/ that requires nothing breaks it; both feature
 * modules re-export these unchanged, so their existing importers keep working.
 */

'use strict';

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * Walk every object in a definition, depth-first, calling `fn` on each. Used
 * for the scrub + reference sweeps: the same id can appear on an action, on a
 * sequence step, or on a component prop, and a walker means adding a rule does
 * not mean finding all three places again.
 */
function walkObjects(node, fn) {
    if (Array.isArray(node)) {
        for (const item of node) walkObjects(item, fn);
        return;
    }
    if (!isObject(node)) return;
    fn(node);
    for (const value of Object.values(node)) walkObjects(value, fn);
}

// ── Step walking (shared) ───────────────────────────────
//
// Steps nest inside loop bodies and parallel branches (same shapes
// validate.js collectCallLayerSteps walks); everything else is flat.

function walkSteps(steps, fn) {
    if (!Array.isArray(steps)) return;
    for (const s of steps) {
        if (!isObject(s)) continue;
        fn(s);
        if (s.type === 'loop') walkSteps(s.body, fn);
        if (s.type === 'parallel' && Array.isArray(s.branches)) {
            for (const branch of s.branches) walkSteps(branch, fn);
        }
    }
}

/**
 * Every TRIGGER of one graph — the primary `trigger`, then each extra entry
 * point in `triggers[]`. Both are nodes of the graph the canvas draws and both
 * can carry the same author-supplied fields a step can.
 */
function walkTriggers(graph, layerKey, fn) {
    if (isObject(graph.trigger)) fn(graph.trigger, layerKey, true);
    if (!Array.isArray(graph.triggers)) return;
    for (const t of graph.triggers) if (isObject(t)) fn(t, layerKey, true);
}

/**
 * Every NODE of every graph in a definition — the root graph, then each layer —
 * with the layer's key so a caller can say WHERE it found something, and a flag
 * saying whether the node is a trigger.
 *
 * Both sweeps in automation/portability.js wrote this root-then-layers loop by hand, and anything else
 * that needs to read a whole definition (the Solution dependency graph, and the
 * packager after it) would have written it a third time. Nesting rules live in
 * walkSteps; this says what a definition is made of. One place each.
 *
 * TRIGGERS were missing from that answer until BFSF-408. Steps were the only
 * things that could carry pinned sample data, so "every step" and "every node
 * that can hold one of this user's captured payloads" were the same set — and
 * the moment a trigger could be pinned too, the export sweep (portability.js)
 * stopped covering the thing it promises to cover, silently. A trigger is a
 * node of the graph; this walker says so, and every consumer that only cares
 * about steps is already `step.type`-guarded (they look for 'approval',
 * 'http_request', 'call_block' — a trigger is type 'trigger', so visiting one
 * is a no-op for them).
 */
function walkAllSteps(definition, fn) {
    if (!isObject(definition)) return;
    walkTriggers(definition, null, fn);
    walkSteps(definition.steps, (s) => fn(s, null, false));
    if (!isObject(definition.layers)) return;
    for (const [key, layer] of Object.entries(definition.layers)) {
        if (!isObject(layer)) continue;
        walkTriggers(layer, key, fn);
        walkSteps(layer.steps, (s) => fn(s, key, false));
    }
}

module.exports = { walkObjects, walkSteps, walkTriggers, walkAllSteps };
