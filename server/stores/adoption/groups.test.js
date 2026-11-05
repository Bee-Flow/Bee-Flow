'use strict';
/**
 * Adoption per group, against the real schemas (PGlite), and the fold of the
 * small groups.
 *
 * Run: cd server && node --test stores/adoption/groups.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');
const { sourceOf, FOLD_BELOW } = require('./groups');

before(async () => {
    await kit.setUp();
    // Three more members in the big group of org A make it five: shown on its own.
    const userStore = require('../userStore');
    const { run } = require('../../db');
    for (const i of [1, 2, 3]) {
        await userStore.createUser({ id: `a-extra${i}`, username: `aextra${i}`, email: `a-extra${i}@adopt.test`, organizationId: kit.ORG_A, role: 'user', passwordHash: 'x' });
        await run(`UPDATE users SET groups = '["a-grp-big"]' WHERE id = $1`, [`a-extra${i}`]);
    }
}, { timeout: 240_000 });
after(kit.tearDown);

test('a group of five is shown, a smaller one folded', async () => {
    const out = await kit.store().groups(kit.scope());
    assert.equal(out.partial, false);
    assert.equal(FOLD_BELOW, 5);
    assert.equal(out.groups.length, 1);
    const big = out.groups[0];
    assert.equal(big.id, 'a-grp-big');
    assert.equal(big.source, 'local');
    assert.equal(big.members, 7);
    assert.equal(big.aiActive, 2);
    assert.equal(big.adoptionRate, 28.6);
    assert.equal(big.makers, 2);
    assert.equal(big.cost, 3.6);
    assert.equal(big.topArea, 'apps');
    assert.deepEqual(out.folded, { count: 1, members: 1, aiActive: 0, adoptionRate: 0, makers: 0, cost: 0, topArea: null });
});

test('the source of a group', () => {
    assert.equal(sourceOf({ id: 'g', azureGroupId: 'x' }), 'entra');
    assert.equal(sourceOf({ id: 'g', source: 'nextcloud' }), 'nextcloud');
    assert.equal(sourceOf({ id: 'g', source: null }), 'local');
});

test('org B\'s groups are not A\'s', async () => {
    const out = await kit.store().groups(kit.scope(kit.ORG_B));
    assert.deepEqual(out.groups, []);
    assert.equal(out.folded?.count, 2);
});
