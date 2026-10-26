// @typecheck strict
/**
 * Steps that read each other's output in a loop.
 *
 * Edges are checked for cycles (graph.cycle), but a DATA reference is a second
 * kind of dependency: step A reading `steps.B.output.x` while B reads
 * `steps.A.output.y` has no edge cycle, and ran green with both reads empty.
 * Each such read is already a `ref.forward` warning on its own; this is the
 * error for the pair (or longer chain), because no order can ever satisfy it.
 */
'use strict';

const { isObject } = require('./helpers');
const { TOPIC_HOST_SPEC } = require('../expr');
const { refHead, tryParseExpr, exprStepIds } = require('./refPaths');
const { collectStepRefs } = require('./stepRules/refSurfaces');

/**
 * The ids of the steps this step reads: `steps.<id>` in a path, a placeholder or an expression.
 * @param {unknown} step
 * @returns {Set<string>}
 */
function stepsReadBy(step) {
    const out = new Set();
    for (const r of collectStepRefs(step)) {
        if (r.kind === 'expr') {
            const { ast } = tryParseExpr(r.src, r.host === 'topics' ? { host: TOPIC_HOST_SPEC } : undefined);
            if (ast) for (const id of exprStepIds(ast)) out.add(id);
        } else if (typeof r.path === 'string') {
            const { root, second } = refHead(r.path);
            if (root === 'steps' && second) out.add(second);
        }
    }
    return out;
}

/**
 * Strongly connected components of the read graph with 2+ steps (Tarjan).
 * @param {Map<string, Set<string>>} reads  step id -> the ids it reads
 * @returns {string[][]}
 */
function readCycles(reads) {
    let counter = 0;
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    /** @type {string[]} */
    const stack = [];
    /** @type {string[][]} */
    const found = [];
    /**
     * @param {string} v
     */
    const visit = (v) => {
        index.set(v, counter); low.set(v, counter); counter += 1;
        stack.push(v); onStack.add(v);
        for (const w of reads.get(v) || []) {
            if (!reads.has(w)) continue;
            if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
            else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
        }
        if (low.get(v) === index.get(v)) {
            /** @type {string[]} */
            const comp = [];
            /** @type {string | undefined} */
            let w;
            do {
                w = stack.pop();
                if (w === undefined) break; // v itself is on the stack, so the loop ends at v first
                onStack.delete(w);
                comp.push(w);
            } while (w !== v);
            if (comp.length > 1) found.push(comp.reverse());
        }
    };
    for (const v of reads.keys()) if (!index.has(v)) visit(v);
    return found;
}

/**
 * @param {{ graph: { steps?: unknown[] }, p: (s: string) => string, pushE: Function }} ctx  validateGraph's context
 */
function checkDataRefCycles(ctx) {
    const { graph, p, pushE } = ctx;
    const reads = new Map();
    for (const step of Array.isArray(graph.steps) ? graph.steps : []) {
        if (!isObject(step)) continue;
        const { id } = /** @type {{ id?: unknown }} */ (step);
        if (typeof id !== 'string') continue;
        reads.set(id, stepsReadBy(step));
    }
    for (const comp of readCycles(reads)) {
        const chain = [...comp, comp[0]].join(' → ');
        pushE({
            code: 'ref.cycle', severity: 'error', path: p(`steps[${comp[0]}]`),
            message: `Steps ${comp.join(' and ')} read each other's output (${chain}), so whichever runs second reads nothing from the other (the read of the later step comes back empty).`,
            hint: 'Break the loop: move the value one of them needs into an earlier step, or drop the binding that points back.',
        });
    }
}

module.exports = { checkDataRefCycles, stepsReadBy, readCycles };
