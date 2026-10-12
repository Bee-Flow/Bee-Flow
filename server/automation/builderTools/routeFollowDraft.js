/**
 * Follow the route, on the AI builder's draft (W8).
 *
 * A step hanging off a Condition that works through a list (a filter, or a
 * switch with an arrayRef) must read what that Condition keeps, not the list
 * it was given: otherwise "kept 3 of 4" on the canvas and every item read
 * anyway. The canvas and the phone re-point such steps on every wiring
 * change through the shared module (shared/expr/routeFollow.mjs); this file
 * applies the same functions to the builder's in-memory draft and phrases
 * what they rewrote as `_warnings` notes, so the model is told which of its
 * refs moved and to where.
 *
 * The shared functions are pure and return a new definition; the draft is
 * mutated in place here (same step slots, so every holder of `graph.steps`
 * sees the change), because every builder tool works on the live draft.
 */

'use strict';

const {
    followRouteAround, followRouteEdit, isListRoute, parsePath, formatPath, relabelSwitchEdges, switchCaseChanges,
} = require('../expr');

/** Copy the rewritten steps into the draft's own array, slot by slot. */
function applyInPlace(graph, definition) {
    if (!definition || !Array.isArray(definition.steps) || definition.steps === graph.steps) return;
    definition.steps.forEach((step, i) => { if (graph.steps[i] !== step) graph.steps[i] = step; });
}

const tokensStart = (tokens, prefix) => !!tokens && !!prefix && prefix.length <= tokens.length
    && prefix.every((t, i) => t.type === tokens[i].type && t.key === tokens[i].key);

/** "what filt_x keeps" / "what sw_x sends down output "pdf"" for a route output path. */
function outputPhrase(to) {
    const t = parsePath(to) || [];
    const id = t[1] ? t[1].key : '?';
    if (!t[3] || t[3].key !== 'matchesByCase' || !t[4]) return `what ${id} keeps`;
    return t[4].key === 'default' ? `what ${id} sends to "Otherwise"` : `what ${id} sends down output "${t[4].key}"`;
}

/** The list field of `step` that now reads `to` (with its tail), else `to` itself. */
function rewrittenPath(step, to) {
    const want = parsePath(to);
    const fe = step && step.forEach;
    const candidates = [fe && fe.overRef, step && step.arrayRef, step && step.overRef, step && step.sourceRef];
    for (const c of candidates) {
        if (typeof c !== 'string') continue;
        const tokens = parsePath(c);
        if (tokensStart(tokens, want)) return formatPath(tokens);
    }
    return to;
}

/** Group `rebound` entries per step, keeping the first target and every source. */
function byStep(rebound) {
    const out = new Map();
    for (const r of rebound || []) {
        const cur = out.get(r.stepId) || { to: r.to, from: [] };
        if (!cur.from.includes(r.from)) cur.from.push(r.from);
        out.set(r.stepId, cur);
    }
    return out;
}

const stepIn = (graph, id) => (graph.steps || []).find(s => s && s.id === id) || null;

/**
 * After steps were added, inserted or moved: each one that hangs off a list
 * Condition reads the output it hangs off, and each list Condition among
 * them hands its outputs to the steps after it. Returns the notes.
 */
function followAddedSteps(graph, ids) {
    const notes = [];
    if (!graph || !Array.isArray(graph.steps)) return notes;
    for (const id of ids || []) {
        if (typeof id !== 'string') continue;
        const { definition, rebound } = followRouteAround(graph, id);
        applyInPlace(graph, definition);
        for (const [stepId, r] of byStep(rebound)) {
            const path = rewrittenPath(stepIn(graph, stepId), r.to);
            notes.push(`Re-pointed ${stepId} to read ${outputPhrase(r.to)}: ${path} (it read ${r.from.join(', ')}).`);
        }
    }
    return notes;
}

/**
 * A switch whose cases changed takes its edges along, as the canvas and the
 * phone do (shared relabelSwitchEdges): a case renamed in place moves its
 * connections and defaultBranch to the new name, a removed case's
 * connections go, a reorder moves nothing. Without this the edges kept the
 * old names while the readers followed, so a step could hang off one output
 * and read another. Returns the notes.
 */
function relabelDraftSwitch(graph, previous, id) {
    const now = stepIn(graph, id);
    if (!now || previous.type !== 'switch' || now.type !== 'switch' || !Array.isArray(graph.edges)) return [];
    const definition = relabelSwitchEdges(graph, id, previous.cases, now.cases);
    if (definition === graph) return [];
    const wired = new Set(graph.edges.filter(e => e && e.from === id).map(e => e.caseName ?? String(e.label || '').replace(/^case:/, '')));
    graph.edges.splice(0, graph.edges.length, ...definition.edges);
    applyInPlace(graph, definition);
    const { renames, removed } = switchCaseChanges(previous.cases, now.cases);
    const notes = [...renames].filter(([from]) => wired.has(from))
        .map(([from, to]) => `Moved the connections of output "${from}" of ${id} to its new name "${to}".`);
    const dropped = [...removed].filter(name => wired.has(name));
    if (dropped.length) notes.push(`Removed the connections of the deleted output(s) ${dropped.map(n => `"${n}"`).join(', ')} of ${id}.`);
    return notes;
}

/**
 * After list Condition `id` itself changed (`previous` is the step before
 * the change): outputs renamed, one ↔ several outputs, a list one level
 * deeper, back to the whole run. Every step that read an old output reads
 * the new one (or, back to the whole run, the list again); a switch's edges
 * follow its renamed and removed cases first.
 */
function followPatchedRoute(graph, previous, id) {
    if (!graph || !Array.isArray(graph.steps) || !previous) return [];
    const notes = relabelDraftSwitch(graph, previous, id);
    const { definition, rebound } = followRouteEdit(graph, id, previous);
    applyInPlace(graph, definition);
    for (const [stepId, r] of byStep(rebound)) {
        notes.push(`Re-pointed ${stepId} from ${r.from.join(', ')} to ${r.to}: the outputs of ${id} changed.`);
    }
    return notes;
}

/**
 * A step whose TYPE was replaced (builder_replace_step). A filter that became
 * a list switch keeps its connection on the first output, as the canvas does
 * when one output grows to several: its plain outgoing edges become
 * `case:<first>`. Then its readers follow, as for a patch.
 */
function followReplacedRoute(graph, previous, id) {
    const now = stepIn(graph, id);
    if (!now || !previous || !(isListRoute(previous) || isListRoute(now))) return [];
    const first = (Array.isArray(now.cases) ? now.cases : []).find(c => c && typeof c.name === 'string' && c.name);
    if (previous.type === 'filter' && isListRoute(now) && now.type === 'switch' && first) {
        for (const e of graph.edges || []) {
            if (e && e.from === id && !e.label) { e.label = `case:${first.name}`; e.caseName = first.name; }
        }
    }
    return followPatchedRoute(graph, previous, id);
}

module.exports = { followAddedSteps, followPatchedRoute, followReplacedRoute };
