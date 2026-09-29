/**
 * Which steps of a routine touch which datatable.
 *
 * Pure: a definition in, a list of {datatableId, stepId, mode, columns} out.
 * The store persists it on every definition save, and three surfaces spend it:
 *
 *   - the node editor's "also used by N other routines";
 *   - the Datatables tab's "used by" panel;
 *   - the guard before a column is removed or renamed, which is the one that
 *     turns a silent breakage into a question.
 *
 * It is written on SAVE rather than derived on read for a reason that is easy
 * to miss: getAutomationsForUser is `WHERE user_id = $1`, so nobody can scan a
 * colleague's routines to build this index. The author's own save is the only
 * moment the information is legitimately in hand.
 *
 * Walks loop bodies and parallel branches exactly as stepContract, validate and
 * portability do — a datatable write buried in a loop is still a write.
 */

'use strict';

const { walkSteps } = require('./stepContract');
const { DATATABLE_WRITE_OPS } = require('./validate/constants');

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

/**
 * Every column key a step names, so the destructive-change guard can answer
 * "which routines read the column you are about to delete". Conditions and
 * written values both count: losing either breaks the step.
 */
function columnsOf(step) {
    const keys = new Set();
    if (Array.isArray(step.where)) {
        for (const w of step.where) if (isObject(w) && typeof w.field === 'string') keys.add(w.field);
    }
    if (Array.isArray(step.sort)) {
        for (const s of step.sort) if (isObject(s) && typeof s.field === 'string') keys.add(s.field);
    }
    if (isObject(step.values)) for (const k of Object.keys(step.values)) keys.add(k);
    if (typeof step.matchColumn === 'string' && step.matchColumn) keys.add(step.matchColumn);
    return [...keys];
}

/**
 * @param {object} definition an automation definition
 * @returns {Array<{datatableId, stepId, mode, columns}>}
 */
function collectDatatableUsage(definition) {
    if (!isObject(definition)) return [];
    const out = [];
    const seen = new Set();

    const visit = (s) => {
        if (!isObject(s) || s.type !== 'datatable') return;
        if (!s.datatableId || typeof s.datatableId !== 'string') return;
        if (!s.id || seen.has(s.id)) return;
        seen.add(s.id);
        out.push({
            datatableId: s.datatableId,
            stepId: s.id,
            mode: DATATABLE_WRITE_OPS.has(s.op) ? 'write' : 'read',
            columns: columnsOf(s),
        });
    };

    walkSteps(definition.steps, visit);
    // Inline flowlets are part of the same routine and their steps run in it.
    if (isObject(definition.layers)) {
        for (const layer of Object.values(definition.layers)) {
            if (isObject(layer)) walkSteps(layer.steps, visit);
        }
    }
    return out;
}

/** The distinct table ids a routine touches — for a cheap "does it use any?". */
function datatableIdsUsed(definition) {
    return [...new Set(collectDatatableUsage(definition).map(u => u.datatableId))];
}

/**
 * The top-level nodes of a graph in the order they RUN — a port of the
 * builder's flow/flowOrder.js, kept in step with it so "step 4" on the
 * table's used-by panel is the same 4 the canvas wears.
 *
 * Kahn over `edges`, seeded from the trigger(s). Deterministic (ties break on
 * edge order, then `steps[]` index), total (a cycle's leftovers are appended
 * in authoring order rather than dropped) and shallow (loop bodies and
 * parallel branches are not descended into — they are numbered by their
 * parent). The trigger sits at index 0 and therefore always leads.
 */
function flowOrder(definition) {
    const steps = Array.isArray(definition?.steps) ? definition.steps.filter(Boolean) : [];
    const roots = [definition?.trigger, ...(Array.isArray(definition?.triggers) ? definition.triggers : [])]
        .filter(t => t && t.id);

    const nodes = [...roots, ...steps];
    const index = new Map();
    nodes.forEach((n, i) => { if (n?.id != null && !index.has(n.id)) index.set(n.id, i); });
    if (index.size === 0) return [];

    const edges = (Array.isArray(definition?.edges) ? definition.edges : [])
        .filter(e => e && index.has(e.from) && index.has(e.to));

    const outgoing = new Map();
    const indegree = new Map([...index.keys()].map(id => [id, 0]));
    edges.forEach((e, order) => {
        if (!outgoing.has(e.from)) outgoing.set(e.from, []);
        outgoing.get(e.from).push({ to: e.to, order });
        indegree.set(e.to, (indegree.get(e.to) || 0) + 1);
    });

    const byIndex = (a, b) => index.get(a) - index.get(b);
    const ready = [...index.keys()].filter(id => (indegree.get(id) || 0) === 0).sort(byIndex);

    const out = [];
    const seen = new Set();
    while (ready.length) {
        const id = ready.shift();
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        const next = (outgoing.get(id) || []).slice().sort((a, b) => a.order - b.order);
        for (const { to } of next) {
            const left = (indegree.get(to) || 0) - 1;
            indegree.set(to, left);
            if (left <= 0 && !seen.has(to)) {
                ready.push(to);
                ready.sort(byIndex);
            }
        }
    }
    for (const id of index.keys()) if (!seen.has(id)) out.push(id);
    return out;
}

/**
 * Where every step sits and what it is: stepId → { ordinal, type, op }.
 *
 * `ordinal` is the 1-based run-order number of the step's TOP-LEVEL node —
 * the trigger and notes are skipped, exactly as the canvas numbers them — so a
 * datatable step buried in a loop body reports the loop's number, which is the
 * one a person can find on the canvas. `type` and `op` are the step's own.
 * Steps of inline flowlets (`definition.layers`) have no top-level position
 * and get `ordinal: null`.
 *
 * @returns {Map<string, {ordinal:number|null, type:string|null, op:string|null}>}
 */
function stepPositions(definition) {
    const out = new Map();
    if (!isObject(definition)) return out;
    const topLevel = new Map();
    for (const s of Array.isArray(definition.steps) ? definition.steps : []) {
        if (isObject(s) && s.id) topLevel.set(s.id, s);
    }
    const ordinalOf = new Map();
    let n = 0;
    for (const id of flowOrder(definition)) {
        const s = topLevel.get(id);
        if (!s || s.type === 'note') continue; // a trigger, or a note
        n += 1;
        ordinalOf.set(id, n);
    }
    const record = (s, ordinal) => {
        if (!isObject(s) || !s.id || out.has(s.id)) return;
        out.set(s.id, {
            ordinal,
            type: typeof s.type === 'string' ? s.type : null,
            op: typeof s.op === 'string' ? s.op : null,
        });
    };
    for (const s of topLevel.values()) {
        const ordinal = ordinalOf.get(s.id) ?? null;
        walkSteps([s], (inner) => record(inner, ordinal));
    }
    if (isObject(definition.layers)) {
        for (const layer of Object.values(definition.layers)) {
            if (isObject(layer)) walkSteps(layer.steps, (inner) => record(inner, null));
        }
    }
    return out;
}

module.exports = { collectDatatableUsage, datatableIdsUsed, columnsOf, flowOrder, stepPositions };
