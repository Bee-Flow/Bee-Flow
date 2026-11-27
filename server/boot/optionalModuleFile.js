// @typecheck strict
'use strict';
/**
 * The core's way to reach a file a first-party module owns while that module may be absent
 * (core mode, BEEFLOW_HIDE_MODULES, or a build without it): run the require inside `load`;
 * a MODULE_NOT_FOUND means "absent" and yields null, any other error is rethrown, so a module
 * that is there but broken still fails loudly.
 *
 * A stopgap: each caller is listed in the handoff of the core/modules split and is replaced by
 * a proper port (a registry with a safe default) in a later step.
 */

/**
 * @template T
 * @param {() => T} load a function that requires the module file
 * @returns {T | null}
 */
function optionalModuleFile(load) {
    try {
        return load();
    } catch (err) {
        if (/** @type {NodeJS.ErrnoException} */ (err)?.code === 'MODULE_NOT_FOUND') return null;
        throw err;
    }
}

module.exports = { optionalModuleFile };
