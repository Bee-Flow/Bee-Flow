/**
 * Builder tools: "Flatten a list" (builder_add_array_op op "flatten").
 *
 * The AI names the outer list plus the inner key (`arrayRef` + `childField`)
 * or the whole route (`…messages[*].attachments`); both are stored as the
 * route. The column plan comes from the shared flattenPlan over a sample of
 * the source, so the step the AI adds is the step auto-map would write in
 * the editor. Without any sample a level is stored without `fields`: the
 * run plans from its own data (F28) and the validator asks for the step to
 * be opened once (flatten.columns_unsaved).
 */

const { newId, appendAfter, findStepAnywhere } = require('../draftGraph');
const { sanitizeArrayRef } = require('../bindings');
const { shapeAtRef } = require('../refCheck');
const { OUTPUT_SCHEMAS } = require('../../outputSchemas');
const {
    parsePath, formatPath, normalizeFlattenRoute, routeFromParts, flattenPlan, routeLevels, childNounOf, checkFlattenParents, defaultParents,
    nestedRows, GENERIC_KEYS, joinKey,
} = require('../../expr');

const MAX_SAMPLE_DEPTH = 12;

/** A shape tree as a value: lists hold one entry, every scalar is null. */
function shapeValue(node, depth = 0) {
    if (!node || depth > MAX_SAMPLE_DEPTH) return undefined;
    if (node.t === 'obj') {
        const out = {};
        for (const [k, v] of node.keys) {
            const value = shapeValue(v, depth + 1);
            if (value !== undefined) out[k] = value;
        }
        return out;
    }
    if (node.t === 'arr') {
        const item = shapeValue(node.item, depth + 1);
        return item === undefined ? [] : [item];
    }
    return node.t === 'any' ? undefined : null;
}

/**
 * A run state holding what the route's source is known to return: the tool's
 * curated sample when the source is a plain action, else a value built from
 * the shape the builder knows (`shapeAtRef`). Empty when nothing is known.
 */
function sampleRootFor(graph, route, draftWrap, depth = 0) {
    const tokens = parsePath(route);
    if (!tokens || !tokens.length) return {};
    if (tokens[0].key === 'trigger') {
        const output = shapeValue(shapeAtRef(graph, tokens.slice(0, 2), draftWrap, depth));
        return output === undefined ? {} : { trigger: { output } };
    }
    if (tokens[0].key !== 'steps' || tokens.length < 3 || tokens[2].key !== 'output') return {};
    const id = String(tokens[1].key);
    const sample = curatedSample(findStepAnywhere(graph, id)?.step);
    const output = sample !== undefined ? sample : shapeValue(shapeAtRef(graph, tokens.slice(0, 3), draftWrap, depth));
    return output === undefined ? {} : { steps: { [id]: { output } } };
}

/** The curated sample of a plain (not per-item) action step's tool, or undefined. */
function curatedSample(step) {
    if (!step || step.type !== 'integration_action' || step.forEach) return undefined;
    if (!Object.prototype.hasOwnProperty.call(OUTPUT_SCHEMAS, step.tool)) return undefined;
    return OUTPUT_SCHEMAS[step.tool].sample;
}

/** `…messages[*]` → `…messages`. */
function withoutTrailingWild(path) {
    const tokens = parsePath(path);
    if (!tokens) return path;
    while (tokens.length && tokens[tokens.length - 1].type === 'wild') tokens.pop();
    return formatPath(tokens);
}

/** The first inner list of records under `outer` in the sample, as a route; null when there is none. */
function guessRoute(outer, root) {
    const level = routeLevels(outer, root).find(l => l.depth === 1 && l.records);
    return level ? level.path : null;
}

/**
 * The route a flatten call means: `arrayRef` + `childField`, or `arrayRef`
 * as the route itself (repaired like any list ref), or, for a bare outer
 * list, its one inner list of records. `{ route, notes }` or `{ error }`.
 */
function resolveFlattenRoute(graph, args, draftWrap) {
    if (typeof args.arrayRef !== 'string' || !args.arrayRef.trim()) {
        return { error: 'flatten op requires arrayRef: the outer list (with childField, the list inside each item), or the route itself, e.g. "steps.<id>.output.messages[*].attachments".' };
    }
    const ar = sanitizeArrayRef(args.arrayRef, graph, { draftWrap });
    if (ar.error) return { error: ar.error };
    const outer = withoutTrailingWild(ar.arrayRef);
    const joined = typeof args.childField === 'string' && args.childField.trim() ? routeFromParts(outer, args.childField) : null;
    let route = normalizeFlattenRoute(joined || ar.arrayRef);
    if (!route) route = guessRoute(outer, sampleRootFor(graph, outer, draftWrap));
    if (!route) {
        return { error: `flatten op: ${outer} has no list inside each item to make rows from. Pass childField, the name of the list inside each item (e.g. "attachments").` };
    }
    return { route, notes: ar.notes || [] };
}

/** "from each message: from, to, subject; messageId and threadId come with each attachment" */
function planSentence(parents, route) {
    const child = childNounOf(route);
    const parts = [];
    for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i];
        if (!Array.isArray(p.fields)) { parts.push(`from each ${p.itemVar}: picked from the run's data`); continue; }
        const copied = p.fields.filter(f => f.mode === 'copy').map(f => (f.to === f.from ? f.from : `${f.from} as ${f.to}`));
        const filled = p.fields.filter(f => f.mode === 'fill').map(f => f.to);
        let s = `from each ${p.itemVar}: ${copied.length ? copied.join(', ') : 'nothing'}`;
        if (filled.length) s += `; ${filled.join(' and ')} come${filled.length === 1 ? 's' : ''} with each ${child}`;
        parts.push(s);
    }
    return `Flatten: one row per ${child} (${parts.join('; ')})`;
}

/**
 * No sample of the source: each level is stored without `fields`, so the run
 * plans from its own data (F28). keepFields still names the nearest level's
 * columns, by the generic-key rule only (no sample to find fills or clashes).
 */
function unsampledPlan(route, keepFields) {
    const levels = defaultParents(route).map(({ overRef, itemVar }) => ({ overRef, itemVar, auto: true }));
    if (!keepFields || !keepFields.length || !levels.length) return { parents: levels, notes: [] };
    const nearest = levels[levels.length - 1];
    const tos = new Set();
    nearest.fields = [];
    for (const from of keepFields) {
        const to = GENERIC_KEYS.has(from.toLowerCase()) ? joinKey(nearest.itemVar, from) : from;
        if (tos.has(to)) continue;
        tos.add(to);
        nearest.fields.push({ from, to, mode: 'copy' });
    }
    nearest.auto = false;
    return { parents: levels, notes: ['keepFields: there is no sample of this list yet, so the names were not checked against its items.'] };
}

/** Plan the columns of `route` from the sample. `{ parents, notes }`. */
function planFlatten(graph, route, args, draftWrap) {
    const keepFields = Array.isArray(args.keepFields) ? args.keepFields.filter(k => typeof k === 'string' && k) : null;
    const root = sampleRootFor(graph, route, draftWrap);
    if (!nestedRows(root, route, { keepEmpty: true, limit: 1 })?.rows.length) return unsampledPlan(route, keepFields);
    const plan = flattenPlan(root, route, { keepFields });
    const notes = [];
    if (plan.unknown.length) notes.push(`keepFields: ${plan.unknown.join(', ')} not found on the outer items; left out.`);
    return { parents: plan.parents, notes };
}

function applyAddFlatten(draft, args, draftWrap) {
    const r = resolveFlattenRoute(draft, args, draftWrap);
    if (r.error) return { error: r.error };
    const { parents, notes } = planFlatten(draft, r.route, args, draftWrap);
    const step = {
        id: newId('flat'), type: 'flatten',
        label: args.label || `One row per ${childNounOf(r.route)}`,
        arrayRef: r.route, parents,
        ...(args.keepEmpty === true ? { keepEmpty: true } : {}),
    };
    appendAfter(draft, args.afterStepId, step, { branch: args.branch, caseName: args.caseName, splice: args.splice === true });
    const warnings = [...r.notes, ...notes];
    return { added: step, note: planSentence(parents, r.route), ...(warnings.length ? { _warnings: warnings } : {}) };
}

/**
 * builder_update_step on a flatten (F53): the sugar `childField` and
 * `keepFields` re-plan, a new `arrayRef` re-plans, stored `parents` must fit
 * the route. Mutates `next`; returns an error string or null.
 */
function patchFlatten(graph, next, patch, draftWrap) {
    const rerouted = typeof patch.arrayRef === 'string' || typeof patch.childField === 'string';
    if (rerouted) {
        const err = rerouteFlatten(graph, next, patch, draftWrap);
        if (err) return err;
    }
    const replan = rerouted || Array.isArray(patch.keepFields);
    if (patch.parents !== undefined && !replan) {
        next.parents = patch.parents;
        const reason = checkFlattenParents(next);
        return reason ? `parents does not fit arrayRef (${reason}). Leave parents out to have it planned from the data.` : null;
    }
    if (replan) next.parents = planFlatten(graph, next.arrayRef, { keepFields: patch.keepFields }, draftWrap).parents;
    return null;
}

/** Point a flatten at a new route (and relabel a default label). Error string or null. */
function rerouteFlatten(graph, next, patch, draftWrap) {
    // A new childField alone swaps the inner list under the same outer one.
    const levels = defaultParents(normalizeFlattenRoute(next.arrayRef) || '');
    const innermost = levels.length ? levels[levels.length - 1].overRef : next.arrayRef;
    const base = typeof patch.arrayRef === 'string' ? patch.arrayRef : innermost;
    const r = resolveFlattenRoute(graph, { arrayRef: base, childField: patch.childField }, draftWrap);
    if (r.error) return r.error;
    const oldLabel = `One row per ${childNounOf(normalizeFlattenRoute(next.arrayRef) || r.route)}`;
    if (typeof patch.label !== 'string' && (!next.label || next.label === oldLabel)) next.label = `One row per ${childNounOf(r.route)}`;
    next.arrayRef = r.route;
    return null;
}

module.exports = { applyAddFlatten, patchFlatten, sampleRootFor, planSentence };
