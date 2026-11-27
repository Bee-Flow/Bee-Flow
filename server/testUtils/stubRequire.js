// @typecheck
/**
 * Require-interception for tests (H2).
 *
 * 27 test files hand-roll the same `Module._resolveFilename` patch + a
 * `require.cache` preload to swap a dependency (usually `../db`) for a double
 * before requiring the module under test. This centralises that dance with a
 * clean restore, so a test reads:
 *
 *   const restore = installResolveStub({ '../db': mock.db });
 *   const store = require('./someStore');
 *   // ... assertions ...
 *   restore();   // in an after() hook or at file end
 *
 * Keys are the require strings exactly as written in the module under test
 * (e.g. '../db', '../../telemetry/httpMetrics'). Values are the stub exports.
 *
 * Node caches modules, so install the stub BEFORE the first require of the
 * module under test. If several suites in one file need different stubs, call
 * restore() and delete the module-under-test from require.cache between them.
 */

const Module = /** @type {typeof import('module') & { _resolveFilename: (request: string, parent: NodeJS.Module | null | undefined, ...rest: unknown[]) => string }} */ (require('module'));
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { hasFeatureModule } = require('../core/featureModules');
const { stubFeatureModule } = require('./featureDouble');
const { ROOTS, readDir, toTreePath } = require('../modules/roots/rootSet.cjs');
const log = require('../telemetry/log');

// A key that names a feature module the code under test looks up by name
// (core/featureModules.js, moduleData.lookupFeatureModule) is stubbed there too:
// the caller no longer `require`s it by that string, so the resolve hook alone
// would never see the call. Same stub, same meaning. The name is the tree path
// the key points at, without its extension, and it is mirrored only when it is a
// feature-module name: one registered now, or one a first-party module provides
// (firstParty/<id>.provides.json, read in every root, hidden or not: in core mode
// a module's names are not registered, and a double registered under one makes
// the "present" path of the code under test testable).
const EXTENSION = /\.(?:js|mts|cjs)$/;

/** @type {Set<string> | null} */
let providedNames = null;

/** Every feature-module name a first-party module provides, from the provides files of every root. */
function providedFeatureNames() {
    if (providedNames) return providedNames;
    const names = new Set();
    for (const root of ROOTS) {
        const dir = path.join(root.dir, 'firstParty');
        for (const entry of readDir(dir)) {
            if (!entry.name.endsWith('.provides.json')) continue;
            const provides = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
            for (const name of provides.featureModules || []) names.add(name);
        }
    }
    providedNames = names;
    return names;
}

/** @param {string} name */
function isFeatureName(name) {
    return hasFeatureModule(name) || providedFeatureNames().has(name);
}

/**
 * The tree path of the directory of the file that called installResolveStub (the test), or
 * null when it lies outside every root.
 * @returns {string | null}
 */
function callerTreeDir() {
    const stack = new Error().stack?.split('\n') ?? [];
    for (const line of stack.slice(1)) {
        const m = /\(?((?:file:\/\/)?\/[^():]+):\d+:\d+\)?$/.exec(line.trim());
        if (!m) continue;
        const file = m[1].startsWith('file://') ? fileURLToPath(m[1]) : m[1];
        if (file === __filename) continue;
        return toTreePath(path.dirname(file));
    }
    return null;
}

/**
 * The feature-module name a stub key stands for, or null. The key is a require string as
 * written in the module under test, which sits beside its test: it is resolved against the
 * test's directory. A key copied from a deeper file climbs out of the tree from there; it
 * then names the tree path after its leading `./` and `../` (the old pattern's reading).
 * @param {string} request
 * @param {string | null} fromDir tree path of the test's directory
 * @returns {string | null}
 */
function featureNameOf(request, fromDir) {
    if (!request.startsWith('./') && !request.startsWith('../')) return null;
    const bare = request.replace(EXTENSION, '');
    /** @type {string[]} */
    const candidates = [];
    if (fromDir !== null) {
        const resolved = path.posix.normalize(path.posix.join(fromDir, bare));
        if (resolved !== '..' && !resolved.startsWith('../')) candidates.push(resolved);
    }
    candidates.push(bare.replace(/^(?:\.\.?\/)+/, ''));
    return candidates.find(isFeatureName) ?? null;
}

/**
 * Redirect the given require requests to in-memory stub exports.
 * @param {Record<string, any>} map require-string → stub exports object
 * @returns {() => void} restore function (idempotent)
 */
function installResolveStub(map) {
    const original = Module._resolveFilename;
    const idFor = new Map();

    for (const [request, exportsObj] of Object.entries(map)) {
        const id = `stub:${request}`;
        idFor.set(request, id);
        require.cache[id] = /** @type {NodeJS.Module} */ (/** @type {unknown} */ ({
            id,
            filename: id,
            loaded: true,
            exports: exportsObj,
            children: [],
            paths: [],
        }));
    }

    Module._resolveFilename = function (request, parent, ...rest) {
        if (idFor.has(request)) return idFor.get(request);
        return original.call(this, request, parent, ...rest);
    };

    /** @type {Array<() => void>} */
    const featureRestores = [];
    const fromDir = callerTreeDir();
    for (const [request, exportsObj] of Object.entries(map)) {
        const name = featureNameOf(request, fromDir);
        if (name) featureRestores.push(stubFeatureModule(name, exportsObj));
    }

    let restored = false;
    return function restore() {
        if (restored) return;
        restored = true;
        Module._resolveFilename = original;
        // Last first: two spellings of one file stub one name twice, and the first holds the real getter.
        for (const undo of featureRestores.reverse()) undo();
        for (const id of idFor.values()) delete require.cache[id];
    };
}

/**
 * Drop a module (by the require string relative to `fromDir`, or an absolute
 * path) from require.cache so the next require re-evaluates it against the
 * current stubs. Useful when one test file exercises a module under several
 * stub configurations.
 * @param {string} absolutePath resolved absolute path of the module to evict
 */
function evictModule(absolutePath) {
    try {
        const resolved = require.resolve(absolutePath);
        delete require.cache[resolved];
    } catch (err) { log.debug('not cached or not resolvable, nothing to evict', err); }
}

/**
 * Preload stub exports into require.cache under the REAL resolved path of each
 * module, so every importer, whatever relative string it uses, gets the stub.
 * `localRequire` is the test file's own `require`, which resolves the keys
 * relative to the test. Install before the first require of the module under
 * test.
 *
 *   preloadStubs(require, { '../stores/usageStore': { logUsage: async () => {} } });
 *
 * @param {NodeRequire} localRequire the caller's require
 * @param {Record<string, any>} map require-string (relative to the caller) → stub exports
 */
function preloadStubs(localRequire, map) {
    for (const [request, exportsObj] of Object.entries(map)) {
        const p = localRequire.resolve(request);
        const m = new Module(p);
        m.exports = exportsObj;
        m.loaded = true;
        require.cache[p] = m;
    }
}

module.exports = { installResolveStub, evictModule, preloadStubs };
