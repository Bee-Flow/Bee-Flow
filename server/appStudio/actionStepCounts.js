// @typecheck strict
/**
 * App Studio — how many steps an action holds and where they sit.
 *
 * The step ceiling (LIMITS.MAX_ACTION_STEPS) counts RECURSIVELY: a loop with
 * five steps is six. When an action is over it, "more than N steps" does not say
 * which part to split, so the refusal carries the count per TOP-LEVEL step.
 * Pure: no draft, no I/O. The branches walked are the ones the validator counts
 * (condition then/else, loop steps, switch cases and default, onError handlers,
 * a transaction's children).
 */

'use strict';

const { childStepLists } = require('../shared/appDefinition/stepFlow.mjs');

/**
 * @typedef {{ index: number, kind: string, id?: string, count: number }} StepCount
 */

/** @param {unknown} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The steps nested under one step, in the order the validator walks them:
 * every place a step holds steps (stepFlow.childStepLists), onError handlers and
 * a transaction's children included.
 * @param {Record<string, any>} step
 * @returns {unknown[][]}
 */
function branchesOf(step) {
    return childStepLists(step);
}

/**
 * Steps in a list, nested ones included (an object counts as one step even
 * without a valid kind, as the validator counts it).
 * @param {unknown} steps
 * @returns {number}
 */
function countSteps(steps) {
    if (!Array.isArray(steps)) return 0;
    let n = 0;
    for (const step of steps) {
        n += 1;
        if (isObject(step)) for (const branch of branchesOf(step)) n += countSteps(branch);
    }
    return n;
}

/**
 * The recursive step count of every top-level step: [{ index, kind, id?, count }].
 * @param {unknown} steps
 * @returns {StepCount[]}
 */
function stepCountsByTopLevel(steps) {
    if (!Array.isArray(steps)) return [];
    return steps.map((step, index) => {
        const obj = isObject(step) ? /** @type {Record<string, any>} */ (step) : null;
        /** @type {StepCount} */
        const row = { index, kind: obj && typeof obj.kind === 'string' ? obj.kind : '(no kind)', count: countSteps([step]) };
        if (obj && typeof obj.id === 'string' && obj.id) row.id = obj.id;
        return row;
    });
}

/**
 * One line for the validator's hint: the biggest top-level steps first.
 * @param {StepCount[]} counts
 * @param {number} [max]
 */
function describeStepCounts(counts, max = 12) {
    const sorted = [...counts].sort((a, b) => b.count - a.count || a.index - b.index).slice(0, max);
    const more = counts.length - sorted.length;
    return `Steps per top-level step (recursive): ${sorted.map((c) => `#${c.index} ${c.kind}${c.id ? ` "${c.id}"` : ''} = ${c.count}`).join(', ')}${more > 0 ? `, and ${more} smaller` : ''}.`;
}

/**
 * The validator's `action.too_many_steps` issue, with the counts in the message and the hint.
 * @param {string} path
 * @param {unknown} top  the sequence's top-level steps (absent for a bare action)
 * @param {number} max
 */
function tooManyStepsIssue(path, top, max) {
    const counts = stepCountsByTopLevel(top);
    const total = counts.reduce((sum, c) => sum + c.count, 0);
    return {
        code: 'action.too_many_steps', severity: 'error', path,
        message: `A sequence has more than ${max} steps${total ? ` (${total} counting every nested step)` : ''}.`,
        hint: `Split the action into smaller ones.${counts.length ? ` ${describeStepCounts(counts)}` : ''}`,
    };
}

module.exports = { countSteps, stepCountsByTopLevel, describeStepCounts, tooManyStepsIssue };
