// @typecheck strict
/**
 * Resolution over the roots of the tree: the two hooks server/moduleRoots.cjs installs.
 *
 * A request that fails where it points is looked up at the same tree path in the other
 * roots (relative and absolute requests), a package name asked for from a module root is
 * resolved from the core root first, and a file of a hidden module is not found.
 *
 *   require(), require.resolve(), createRequire()   Module._resolveFilename, wrapped
 *   static and dynamic import                        module.registerHooks({ resolve })
 *
 * Both are needed: registerHooks does not see require.resolve, and the wrapped function
 * does not see an import.
 */

'use strict';

const path = require('node:path');
const { fileURLToPath, pathToFileURL } = require('node:url');
const Module = /** @type {typeof import('node:module') & {
 *   _resolveFilename: (request: string, parent: NodeJS.Module | null | undefined, ...rest: unknown[]) => string,
 * }} */ (/** @type {unknown} */ (require('node:module')));
const { CORE_ROOT, ROOTS, rootOf, hiddenOwner, rootHidden, hiding } = require('./rootSet.cjs');

/** @typedef {NodeJS.ErrnoException & { requireStack?: string[] }} ResolveError */
/** @typedef {{ parentURL?: string, conditions?: string[], importAttributes?: Record<string, string> }} Context */
/** @typedef {{ url: string, format?: string | null, shortCircuit?: boolean }} Resolved */
/** @typedef {(specifier: string, context?: Context) => Resolved} Next */

const INSTALLED = Symbol.for('beeflow.moduleRoots.installed');
const NOT_FOUND = new Set(['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND']);
const RELATIVE = /^\.{1,2}(?:[\\/]|$)/;
/** A parent to resolve package names from: any file in the core root will do. */
const CORE_PARENT = path.join(CORE_ROOT, 'moduleRoots.cjs');

/**
 * Where else a request may live: the same tree path in the other roots, core first.
 * Keyed on the place the request points at, not on who asks, so a test in another
 * package that reaches into server/ follows a moved file as well.
 * @param {string} request as written
 * @param {string | null | undefined} parentFile absolute path of the asking file
 * @returns {string[]} absolute candidates
 */
function alternatives(request, parentFile) {
    /** @type {string | null} */
    let target = null;
    if (path.isAbsolute(request)) target = path.normalize(request);
    else if (RELATIVE.test(request) && parentFile) target = path.resolve(path.dirname(parentFile), request);
    const from = target && rootOf(target);
    if (!target || !from) return [];
    const rel = path.relative(from.dir, target);
    return ROOTS.filter((root) => root !== from && !rootHidden(root)).map((root) => path.join(root.dir, rel));
}

/** @param {string} request */
function isPackageName(request) {
    return !RELATIVE.test(request) && !path.isAbsolute(request) && !request.startsWith('#')
        && !request.startsWith('file:') && !Module.isBuiltin(request);
}

/** Does this file sit in a module root (and so asks for the core's packages)? */
function inModuleRoot(/** @type {string | null | undefined} */ file) {
    const root = file ? rootOf(file) : null;
    return Boolean(root && root.id !== null);
}

/**
 * @param {string} request
 * @param {string} owner module id
 * @param {string | null | undefined} parentFile
 * @param {string} code
 * @returns {ResolveError}
 */
function absentError(request, owner, parentFile, code) {
    /** @type {ResolveError} */
    const err = new Error(`Cannot find module '${request}': module "${owner}" is not present`
        + (parentFile ? `\nRequire stack:\n- ${parentFile}` : ''));
    err.code = code;
    if (parentFile) err.requireStack = [parentFile];
    return err;
}

/**
 * @param {unknown} err
 * @returns {err is ResolveError}
 */
function isNotFound(err) {
    return err instanceof Error && NOT_FOUND.has(String(/** @type {ResolveError} */ (err).code));
}

/**
 * Run `attempt` on each candidate until one resolves; a candidate that is not found is
 * skipped, any other failure is thrown.
 * @template T
 * @param {string[]} candidates
 * @param {(candidate: string) => T} attempt
 * @returns {{ found: T } | null}
 */
function firstFound(candidates, attempt) {
    for (const candidate of candidates) {
        try {
            return { found: attempt(candidate) };
        } catch (err) {
            if (!isNotFound(err)) throw err;
        }
    }
    return null;
}

function installRequireHook() {
    const original = Module._resolveFilename;
    const coreRequire = Module.createRequire(CORE_PARENT);

    /**
     * @param {string} request
     * @param {NodeJS.Module | null | undefined} parent
     * @param {unknown[]} rest
     */
    function resolveOnce(request, parent, rest) {
        const found = original.call(Module, request, parent, ...rest);
        const owner = hiddenOwner(found);
        if (owner) throw absentError(request, owner, parent && parent.filename, 'MODULE_NOT_FOUND');
        return found;
    }

    Module._resolveFilename = function resolveFilename(request, parent, ...rest) {
        const parentFile = parent && parent.filename;
        if (isPackageName(request) && inModuleRoot(parentFile)) {
            const fromCore = firstFound([request], (name) => coreRequire.resolve(name));
            if (fromCore) return fromCore.found;
        }
        try {
            return resolveOnce(request, parent, rest);
        } catch (err) {
            if (!isNotFound(err)) throw err;
            const elsewhere = firstFound(alternatives(request, parentFile), (c) => resolveOnce(c, parent, rest));
            if (elsewhere) return elsewhere.found;
            throw err;
        }
    };
}

/**
 * @param {string | undefined} url
 * @returns {string | null}
 */
function fileOf(url) {
    return url && url.startsWith('file:') ? fileURLToPath(url) : null;
}

function installImportHook() {
    const coreParentUrl = pathToFileURL(CORE_PARENT).href;

    /**
     * @param {string} specifier
     * @param {Context} context
     * @param {Next} next
     */
    function resolveOnce(specifier, context, next) {
        const result = next(specifier, context);
        const file = fileOf(result.url);
        const owner = file ? hiddenOwner(file) : null;
        if (owner) throw absentError(specifier, owner, fileOf(context.parentURL), 'ERR_MODULE_NOT_FOUND');
        return result;
    }

    /**
     * @param {string} specifier
     * @param {Context} context
     * @param {Next} next
     */
    function resolve(specifier, context, next) {
        const parentFile = fileOf(context.parentURL);
        if (isPackageName(specifier) && inModuleRoot(parentFile)) {
            const fromCore = firstFound([specifier], (name) => next(name, { ...context, parentURL: coreParentUrl }));
            if (fromCore) return fromCore.found;
        }
        try {
            return resolveOnce(specifier, context, next);
        } catch (err) {
            if (!isNotFound(err)) throw err;
            const request = fileOf(specifier) ?? specifier;
            const elsewhere = firstFound(alternatives(request, parentFile),
                (c) => resolveOnce(pathToFileURL(c).href, context, next));
            if (elsewhere) return elsewhere.found;
            throw err;
        }
    }

    const { registerHooks } = /** @type {{ registerHooks?: (hooks: { resolve: typeof resolve }) => unknown }} */ (
        /** @type {unknown} */ (Module));
    if (typeof registerHooks === 'function') registerHooks({ resolve });
}

/** Patch resolution once per thread, and only when there is something to resolve. */
function install() {
    const flags = /** @type {Record<symbol, boolean>} */ (/** @type {unknown} */ (Module));
    if (flags[INSTALLED] || (ROOTS.length === 1 && !hiding)) return;
    flags[INSTALLED] = true;
    installRequireHook();
    installImportHook();
}

module.exports = { install, alternatives };
