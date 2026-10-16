// @typecheck
/**
 * Run a resolution and keep the misses it logged, for a caller that must decide
 * on its own inputs before it acts (a live write with a hole in it).
 */
'use strict';

const { bindingLogStore, noteMiss } = require('./bind');

/**
 * The misses are still reported to the surrounding step log, so the step row
 * and the run summary see them as before.
 * @template T
 * @param {() => T} fn
 * @returns {{ value: T, misses: object[] }}
 */
function captureBindingMisses(fn) {
    const local = [];
    const value = bindingLogStore.run({ entries: local, field: null }, fn);
    for (const e of local) noteMiss({ ...e });
    return { value, misses: local };
}

module.exports = { captureBindingMisses };
