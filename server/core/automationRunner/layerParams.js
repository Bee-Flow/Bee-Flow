// @typecheck
/**
 * A Flowlet's declared input types, checked where the call enters it.
 *
 * `layer.trigger.params[]` says `{ name, type }`, but nothing held a caller to
 * it: a `type: 'number'` param bound to "abc" reached the layer as text and
 * became 0 at the first sum. A numeric string now becomes the number; anything
 * else that is not empty fails the call naming the PARAMETER (never the value).
 */
'use strict';

/**
 * @param {{ trigger?: { params?: unknown } }} layer
 * @param {Record<string, unknown>} inputs  the mapped inputs, already resolved
 * @param {string} stepId  the calling step, for the message
 * @returns {Record<string, unknown>} the inputs with number params converted
 */
function coerceLayerInputs(layer, inputs, stepId) {
    const params = layer && layer.trigger && Array.isArray(layer.trigger.params) ? layer.trigger.params : [];
    const out = { ...inputs };
    for (const p of params) {
        if (!p || (p.type !== 'number' && p.type !== 'integer') || typeof p.name !== 'string') continue;
        const v = out[p.name];
        if (v === undefined || v === null || v === '') continue;
        const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
        if (!Number.isFinite(n) || (p.type === 'integer' && !Number.isInteger(n))) {
            /** @type {import('./runnerError.types').RunnerError} */
            const err = new Error(`Step "${stepId}": the input "${p.name}" must be ${p.type === 'integer' ? 'a whole number' : 'a number'}.`);
            err.errorClass = 'ValidationError';
            throw err;
        }
        out[p.name] = n;
    }
    return out;
}

module.exports = { coerceLayerInputs };
