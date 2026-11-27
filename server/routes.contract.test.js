'use strict';

/**
 * The router is held to auth/routes.contract.json: every mounted route is in the
 * contract, and none carries a weaker gate class than recorded
 * (auth/routeContract.js explains the classes).
 *
 * auth/accessRegistry.sweep.test.js proves every route is accounted for; this
 * test proves the gate did not get weaker. A route that moves from a platform
 * gate to an org permission, or from a permission to a bare session, stays
 * accounted for and still turns red here.
 *
 * The walk loads the real app in a child process (scripts/api-reference-walk.cjs,
 * the same walk the API reference is generated from), so it needs
 * server/node_modules and takes a few seconds; auth/accessRegistry.drift.test.js
 * pays the same price for the same reason.
 *
 * After a route change: npm run gen:routes-contract, then READ the diff. A line
 * whose class went down is the change to review.
 *
 * With a first-party module absent (core mode, BEEFLOW_HIDE_MODULES=all, or an
 * edition that leaves it out) the walk runs with the same modules as this
 * process, and the contract still records the whole product: a recorded route
 * that is not mounted is excused only when the file that registers it belongs to
 * a module that is not loaded (testUtils/absentModuleRoutes.js). Every other
 * check is the same; with every module present nothing is excused.
 *
 * Run: cd server && node --test routes.contract.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const rc = require('./auth/routeContract');
const observe = require('./testUtils/routeContractObserve');
const { routesOfAbsentModules } = require('./testUtils/absentModuleRoutes');

/** The variables that say which modules are here: the walk sees the modules this process sees. */
const MODULE_ENV = ['BEEFLOW_HIDE_MODULES', 'BEEFLOW_MODULE_ROOTS', 'BEEFLOW_EDITION', 'BEEFLOW_MODULES'];

/**
 * spawnSync with the module variables of this process added to the walk's own environment.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} opts
 */
function spawnWithModules(cmd, args, opts) {
    const moduleEnv = Object.fromEntries(MODULE_ENV.filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    return spawnSync(cmd, args, { ...opts, env: { ...opts.env, ...moduleEnv } });
}

let observed;
let recorded;
/** Recorded routes not mounted because their module is not loaded, with that module. */
let excused = new Map();

before(async () => {
    const { walkServer } = await import(path.join(__dirname, '..', 'scripts', 'gen-api-reference.mjs'));
    observed = observe.observeContract(walkServer({ server: __dirname, spawn: spawnWithModules }));
    recorded = observe.readContract();
    excused = routesOfAbsentModules(Object.keys(recorded.routes).filter((id) => !observed[id]));
});

test('the contract file exists and the walk saw the whole app', () => {
    assert.ok(recorded && recorded.routes, 'auth/routes.contract.json is missing: npm run gen:routes-contract');
    // The routes of absent modules are not mounted: they count against the floor as walked.
    const walked = Object.keys(observed).length + excused.size;
    assert.ok(walked > 1500, `suspiciously few routes walked: ${Object.keys(observed).length} (and ${excused.size} of absent modules)`);
});

test('every mounted route is in the contract, and the contract names no route that is gone', () => {
    const d = rc.compareContract(recorded.routes, observed);
    d.stale = d.stale.filter((id) => !excused.has(id));
    assert.deepEqual([...d.missing, ...d.stale], [],
        `auth/routes.contract.json is out of date:\n${rc.describeDiff({ ...d, weakened: [], unaccounted: [], openWithoutReason: [] })}\n` +
        'Run npm run gen:routes-contract and commit the file; review every line whose class went down.');
});

test('no route carries a weaker gate class than recorded', () => {
    const d = rc.compareContract(recorded.routes, observed);
    assert.deepEqual(d.weakened, [],
        `these routes let more callers through than the contract records:\n${rc.describeDiff({ ...d, missing: [], stale: [], unaccounted: [], openWithoutReason: [] })}\n` +
        'Either restore the gate, or (a deliberate change) regenerate the contract and say why in the commit.');
});

test('every route has a gate somewhere, and every open route a reason', () => {
    const d = rc.compareContract(recorded.routes, observed);
    assert.deepEqual([...d.unaccounted, ...d.openWithoutReason], [],
        `${rc.describeDiff({ ...d, missing: [], stale: [], weakened: [] })}\n` +
        'Gate the route, declare it in auth/accessRegistry.js, or list it with a reason in auth/openRoutes.js.');
});
