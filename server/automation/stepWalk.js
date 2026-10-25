// @typecheck strict

/** @param {unknown} v @returns {v is Record<string, any>} */
function isObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// Walk a graph's steps, descending into loop bodies and parallel branches —
// the same nesting validate.js/portability.js walk. Flat for everything else.
/**
 * @param {unknown} steps
 * @param {(step: Record<string, any>) => void} fn
 */
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
 * The declared input params of a Step (root layer_input trigger).
 * @param {Record<string, any> | null | undefined} definition
 */
function stepParams(definition) {
    const params = definition?.trigger?.params;
    if (!Array.isArray(params)) return [];
    return params
        .filter(isObject)
        .map(p => ({ name: p.name, type: p.type || 'string', required: !!p.required, description: p.description || '' }))
        .filter(p => p.name);
}

/**
 * The output field names a Step returns (its single layer_output step).
 * @param {Record<string, any> | null | undefined} definition
 */
function stepOutputFields(definition) {
    const out = (definition?.steps || []).find((/** @type {Record<string, any>} */ s) => s && s.type === 'layer_output');
    const fields = out && isObject(out.fields) ? out.fields : {};
    return Object.keys(fields);
}

module.exports = { isObject, walkSteps, stepParams, stepOutputFields };
