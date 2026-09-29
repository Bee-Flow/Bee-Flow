'use strict';
/**
 * The target-org licence check: the same question the runtime asks before it
 * enforces an org's types (license.hasFeature over the org alone), with the
 * tier fallback, and "locked" whenever it cannot be answered.
 *
 * Run: node --test core/privacy/customData/licence.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createLicenceCheck, FEATURE } = require('./licence');

const quiet = { warn: () => {} };

test('asks hasFeature for the TARGET org only, never with the caller\'s own tier', async () => {
    const calls = [];
    const check = createLicenceCheck({
        license: { hasFeature: async (scope, feature) => { calls.push([scope, feature]); return scope.organizationId === 'ent'; } },
        log: quiet,
    });
    assert.equal(await check({ organizationId: 'ent', userId: 'u1' }), true);
    assert.equal(await check({ organizationId: 'com', userId: 'u1' }), false);
    assert.deepEqual(calls[0], [{ organizationId: 'ent' }, FEATURE]);
});

test('falls back to resolveTier + tierHasFeature', async () => {
    const check = createLicenceCheck({
        license: {
            resolveTier: async ({ organizationId }) => (organizationId === 'ent' ? 'enterprise' : 'community'),
            tiers: { tierHasFeature: (tier, feature) => tier === 'enterprise' && feature === FEATURE },
        },
        log: quiet,
    });
    assert.equal(await check({ organizationId: 'ent' }), true);
    assert.equal(await check({ organizationId: 'com' }), false);
});

test('fails closed when it cannot be answered', async () => {
    const check = createLicenceCheck({ license: { hasFeature: async () => { throw new Error('db down'); } }, log: quiet });
    assert.equal(await check({ organizationId: 'ent' }), false);
    assert.equal(await check({ organizationId: '' }), false);
});
