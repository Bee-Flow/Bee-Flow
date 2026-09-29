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

const Module = require('module');

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
        require.cache[id] = {
            id,
            filename: id,
            loaded: true,
            exports: exportsObj,
            children: [],
            paths: [],
        };
    }

    Module._resolveFilename = function (request, parent, ...rest) {
        if (idFor.has(request)) return idFor.get(request);
        return original.call(this, request, parent, ...rest);
    };

    let restored = false;
    return function restore() {
        if (restored) return;
        restored = true;
        Module._resolveFilename = original;
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
    } catch (_) { /* not cached / not resolvable — nothing to evict */ }
}

module.exports = { installResolveStub, evictModule };
