// @typecheck strict
/**
 * An optional lazy lookup of a module-owned file from a core boot file: the
 * require stays in the caller (so it stays lazy and the import scan sees it
 * where it is), this only turns "that file is not here" into null.
 *
 * A first-party module can be absent (core mode, BEEFLOW_HIDE_MODULES; later a
 * module that is simply not installed). A core file that still needs one of its
 * files for something that is not a composition row (a callback, a boot-time
 * secret) asks through this and takes a safe default on null. Each use is a
 * stopgap until a port replaces it; the list is in the handoff of the split.
 *
 *     const waits = requireIfPresent(() => require('../appStudio/approvalWaits.mts'));
 *     if (waits) await waits.releaseWait(...);
 */

'use strict';

const NOT_FOUND = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);

/**
 * The value of `load()`, or null when it throws because a module file is not there.
 * Any other error is thrown on.
 * @template T
 * @param {() => T} load
 * @returns {T | null}
 */
function requireIfPresent(load) {
    try {
        return load();
    } catch (err) {
        if (err && typeof err === 'object' && NOT_FOUND.has(String(/** @type {{ code?: unknown }} */ (err).code))) return null;
        throw err;
    }
}

module.exports = { requireIfPresent };
