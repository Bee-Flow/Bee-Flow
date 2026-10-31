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
 * Run: cd server && node --test routes.contract.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const rc = require('./auth/routeContract');
const observe = require('./testUtils/routeContractObserve');

let observed;
let recorded;

before(async () => {
    const { walkServer } = await import(path.join(__dirname, '..', 'scripts', 'gen-api-reference.mjs'));
    observed = observe.observeContract(walkServer({ server: __dirname }));
    recorded = observe.readContract();
});

test('the contract file exists and the walk saw the whole app', () => {
    assert.ok(recorded && recorded.routes, 'auth/routes.contract.json is missing: npm run gen:routes-contract');
    assert.ok(Object.keys(observed).length > 1500, `suspiciously few routes walked: ${Object.keys(observed).length}`);
});

test('every mounted route is in the contract, and the contract names no route that is gone', () => {
    const d = rc.compareContract(recorded.routes, observed);
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
