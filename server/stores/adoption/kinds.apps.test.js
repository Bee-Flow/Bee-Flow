'use strict';
/**
 * The apps module's kind of the Adoption report (kinds.apps.js), against the
 * real schemas (PGlite, ./adoption.testkit.js).
 *
 * Run: cd server && node --test stores/adoption/kinds.apps.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

kit.use();

test('usage and cost of the apps of org A; the guest row of the public page is not counted', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.deepEqual(k.app.usage, { events: 1, people: 1, label: 'action_runs' });
    assert.equal(k.app.cost, 2, 'the guest row of the public page is not counted');
});

test('with a group, the cost of an app narrows to its members', async () => {
    const small = await kit.store().studio(kit.scope(kit.ORG_A, { groupId: 'a-grp-small' }));
    assert.equal(small.kinds.find((r) => r.kind === 'app')?.cost, 0);
    const big = await kit.store().studio(kit.scope(kit.ORG_A, { groupId: 'a-grp-big' }));
    assert.equal(big.kinds.find((r) => r.kind === 'app')?.cost, 2, 'the colleague of the big group ran the app');
});

test('a colleague who runs an app counts as its user, the owner only pays', async () => {
    const out = await kit.store().studioItems(kit.scope(), 'app', 50);
    assert.equal(out.items[0].people, 1);
    assert.equal(out.topPeople[0].person, 'a-colleague');
    assert.equal(out.topPeople[0].cost, 2);
    assert.ok(!out.topPeople.some((p) => p.person.startsWith('guest_')));
});
