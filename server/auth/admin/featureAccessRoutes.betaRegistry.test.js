'use strict';

/**
 * GET /beta-features: the beta catalogue an administrator sees leaves out the
 * betas of a platform module that is not active on this install, and shows
 * the whole catalogue when nothing is inactive or the module state cannot be
 * read (auth/admin/featureAccessRoutes.js visibleBetaRegistry).
 *
 * The router is served by testUtils/routeHarness; the module state and the
 * organisation list are swapped on the objects the route calls them through.
 *
 * Run: cd server && node --require ./testUtils/registerFeatures.js --test auth/admin/featureAccessRoutes.betaRegistry.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const h = require('../../testUtils/routeHarness');

const { db, swaps } = h.sessionGated(['requireAuth', 'requireAdmin']);

const router = require('./featureAccessRoutes');
const userStore = require('../../stores/userStore');
const modules = require('../../modules');
const { BETA_FEATURES } = require('../../core/entitlements/betaFeatures');

const api = h.serve('/', router, { user: { id: 'root', role: 'admin', organizationId: null } });

/** What the module layer answers for "which capabilities are inactive". */
let inactive = async () => new Set();

test.before(async () => {
    await db.settle();
    swaps.swap(userStore, 'getAllOrganizations', async () => []);
    swaps.swap(modules, 'listInactiveCapabilityIds', () => inactive());
});
test.after(async () => {
    swaps.restore();
    await api.close();
});

const ALL = BETA_FEATURES.map((f) => f.id);
const shown = async () => {
    const res = await api.call('GET', '/beta-features');
    assert.equal(res.status, 200, res.text);
    return res.body.registry.map((/** @type {{ id: string }} */ f) => f.id);
};

test('the betas of an inactive module are left out of the catalogue', async () => {
    assert.ok(ALL.length >= 2, 'the catalogue has betas to leave out');
    inactive = async () => new Set([ALL[0]]);
    assert.deepEqual(await shown(), ALL.slice(1));
});

test('with nothing inactive, or no answer at all, the whole catalogue is shown', async () => {
    inactive = async () => new Set();
    assert.deepEqual(await shown(), ALL);
    inactive = async () => /** @type {any} */ (null);
    assert.deepEqual(await shown(), ALL);
});

test('a module state that cannot be read shows the whole catalogue rather than an empty panel', async () => {
    inactive = async () => { throw new Error('module store is away'); };
    assert.deepEqual(await shown(), ALL);
});
