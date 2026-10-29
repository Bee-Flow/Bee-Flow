// @typecheck strict
'use strict';

/**
 * Freeze a value and everything inside it, so a shared constant cannot be
 * changed by whoever receives it.
 * @template T
 * @param {T} value
 * @returns {T}
 */
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const key of Object.keys(value)) deepFreeze(/** @type {Record<string, unknown>} */ (value)[key]);
    }
    return value;
}

module.exports = { deepFreeze };
