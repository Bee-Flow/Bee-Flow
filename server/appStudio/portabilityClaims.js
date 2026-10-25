// @typecheck strict

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepClone(value) {
    if (value === null || typeof value !== 'object') return value;
    try { return structuredClone(value); }
    catch { return JSON.parse(JSON.stringify(value)); }
}

/**
 * @param {unknown} value
 * @param {number} max
 */
function claimText(value, max) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : null;
}

module.exports = { isObject, deepClone, claimText };
