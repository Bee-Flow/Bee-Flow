'use strict';
/**
 * The registry recorder of boot/composition.registries.characterisation.test.js:
 * a child process that requires boot/featureRegistrations.js the way index.js
 * does (the module-roots resolver first) and writes what core's registries hold
 * afterwards to a JSON file.
 *
 *   cd server && node boot/compositionRegistries.testkit.cjs <out.json>
 *
 * A child process because the test runner preloads part of the registrations
 * (testUtils/registerFeatures.js) and the setter recording below has to see
 * every module from its first load.
 *
 * Setters: while featureRegistrations.js loads, every module that is loaded gets
 * each exported function named set<Upper>… wrapped, so a call is recorded as
 * { module: tree path, setter }. That is how "which setters boot/lateBoundPorts.js
 * filled" is read without reading its text. A module whose exports cannot be
 * changed (an ES module namespace) is listed under `unwrappable` instead.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const outFile = process.argv[2];
if (!outFile) {
    process.stderr.write('usage: compositionRegistries.testkit.cjs <out.json> (cwd: server/)\n');
    process.exit(2);
}

const { toTreePath } = require('../moduleRoots.cjs');

/** @type {Array<{ module: string, setter: string }>} */
const setterCalls = [];
/** @type {Set<string>} */
const unwrappable = new Set();
const SETTER = /^set[A-Z]/;

/** @param {string} file @param {any} exports */
function wrapSetters(file, exports) {
    if (!exports || (typeof exports !== 'object' && typeof exports !== 'function')) return;
    const rel = toTreePath(file) || file;
    for (const key of Object.keys(exports)) {
        const fn = exports[key];
        if (!SETTER.test(key) || typeof fn !== 'function' || fn.__compositionWrapped) continue;
        const wrapped = function recordSetter(/** @type {any[]} */ ...args) {
            setterCalls.push({ module: rel, setter: key });
            return fn.apply(this, args);
        };
        Object.defineProperty(wrapped, '__compositionWrapped', { value: true });
        try { exports[key] = wrapped; } catch (_) { unwrappable.add(rel); }
    }
}

const realLoad = Module._load;
Module._load = function recordLoad(request, parent, isMain) {
    const exports = realLoad.apply(this, [request, parent, isMain]);
    let file = null;
    try { file = Module._resolveFilename(request, parent, isMain); } catch (_) { /* a builtin */ }
    if (file && path.isAbsolute(file) && !file.includes(`${path.sep}node_modules${path.sep}`)) wrapSetters(file, exports);
    return exports;
};

require('./featureRegistrations');
Module._load = realLoad;

const { featureModuleNames } = require('../core/featureModules');
const { listToolFamilies } = require('../core/tools/toolFamilyRegistry');
const { runnerPortNames, runnerPort } = require('../core/automationRunner/featurePorts');
const { integrationClientNames } = require('../core/integrations/integrationClients');
const { erasurePortNames } = require('../stores/user/erasurePorts');
const { liveListenerLabels } = require('../stores/datatableStore/liveChanges');
const { TOOLSETS } = require('../integrations/coreToolsets');

const out = {
    featureModules: featureModuleNames(),
    toolFamilies: listToolFamilies().map((f) => ({ name: f.name, order: f.order })),
    toolsets: Object.entries(TOOLSETS).map(([name, tools]) => ({ name, tools: Array.isArray(tools) ? tools.length : typeof tools })),
    runnerPorts: runnerPortNames().map((name) => ({ name, fns: Object.keys(runnerPort(name)) })),
    integrationClients: integrationClientNames(),
    erasurePorts: erasurePortNames(),
    datatableListeners: liveListenerLabels(),
    setters: setterCalls,
    unwrappable: [...unwrappable].sort(),
};
fs.writeFileSync(outFile, JSON.stringify(out));
process.exit(0);
