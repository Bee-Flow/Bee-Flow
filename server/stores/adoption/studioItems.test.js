'use strict';
/**
 * The drill-down of one Studio kind against the real schemas (PGlite).
 *
 * Run: cd server && node --test stores/adoption/studioItems.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

test('the drill-down lists the objects with owner name, audience and uses', async () => {
    const out = await kit.store().studioItems(kit.scope(), 'agent', 50);
    assert.equal(out.total, 2);
    assert.equal(out.items[0].id, 'a-agent', 'the used agent first');
    assert.equal(out.items[0].ownerName, 'Owner A');
    assert.equal(out.items[0].audience, 'org');
    assert.equal(out.items[0].people, 1);
    assert.equal(out.items[0].uses, 1);
    assert.equal(out.items[0].cost, 1);
    assert.deepEqual(out.unused.map((u) => u.id), ['a-agent2'], 'published and unused');
    assert.deepEqual(out.topPeople.map((p) => p.person), ['a-colleague', 'a-owner']);
    assert.ok(out.items.every((i) => i.id.startsWith('a-')), 'nothing of org B');
});

test('a colleague who runs an app counts as its user, the owner only pays', async () => {
    const out = await kit.store().studioItems(kit.scope(), 'app', 50);
    assert.equal(out.items[0].people, 1);
    assert.equal(out.topPeople[0].person, 'a-colleague');
    assert.equal(out.topPeople[0].cost, 2);
    assert.ok(!out.topPeople.some((p) => p.person.startsWith('guest_')));
});

test('org B sees its own objects, never A\'s', async () => {
    const out = await kit.store().studioItems(kit.scope(kit.ORG_B), 'automation', 50);
    assert.deepEqual(out.items.map((i) => i.id), ['b-auto']);
    const unknown = await kit.store().studioItems(kit.scope('org-nobody'), 'agent', 50);
    assert.equal(unknown?.total, 0);
});

test('an unknown kind answers null', async () => {
    assert.equal(await kit.store().studioItems(kit.scope(), 'nope', 50), null);
});

