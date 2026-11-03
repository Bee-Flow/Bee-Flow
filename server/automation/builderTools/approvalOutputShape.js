// @typecheck strict
/**
 * What `steps.<approval>.output` holds, for the builder's binding checks
 * (refCheck.js): the keys of the output contract itself
 * (core/automationModel/approvalOutput.mts, the one producer for a live
 * decision, a dry run and a harness alike), never whatever a dry run happened
 * to record. The keys are fixed, so the shape is complete (`sure`): a key
 * outside the contract is refused. `answers` holds the step's own questions
 * when it declares them (an answer left empty may be missing: not sure),
 * `votes` a panel's votes.
 */

'use strict';
const { ANY } = require('./shapeTree');
const { approvalOutput } = require('../../core/automationModel/approvalOutput.mts');

const isPlainObject = (/** @type {unknown} */ v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** @param {Array<[string, any]>} entries */
const obj = (entries, { open = false, sure = true } = {}) => ({ t: 'obj', keys: new Map(entries), open, sure });

/** @param {{ approval?: { fields?: unknown } }} step */
function approvalOutputShape(step) {
    const declared = isPlainObject(step?.approval) && Array.isArray(step.approval?.fields) ? step.approval.fields : [];
    /** @type {string[]} */
    const names = [];
    for (const f of /** @type {unknown[]} */ (declared)) {
        const name = isPlainObject(f) ? /** @type {{ name?: unknown }} */ (f).name : null;
        if (typeof name === 'string' && name) names.push(name);
    }
    /** @type {Record<string, any>} */
    const byKey = {
        approved: { t: 'bool' }, by: { t: 'str' }, reason: { t: 'str' }, decidedAt: { t: 'str' },
        answers: names.length ? obj(names.map((n) => [n, ANY]), { sure: false }) : obj([], { open: true, sure: false }),
        votes: { t: 'arr', item: obj([], { open: true, sure: false }), sure: true },
    };
    return obj(Object.keys(approvalOutput()).map(k => [k, byKey[k] || ANY]));
}

module.exports = { approvalOutputShape };
