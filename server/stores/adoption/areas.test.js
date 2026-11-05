'use strict';
/**
 * Where the AI goes, against the real ledger table (PGlite).
 *
 * Run: cd server && node --test stores/adoption/areas.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');
const { AREA_IDS } = require('../../shared/usageAreas');

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

test('every area in vocabulary order, zero rows included, org A only', async () => {
    const out = await kit.store().areas(kit.scope());
    assert.deepEqual(out.areas.map((a) => a.area), [...AREA_IDS]);
    const by = Object.fromEntries(out.areas.map((a) => [a.area, a]));
    assert.equal(by.agents.cost, 1);
    assert.equal(by.agents.calls, 1, 'the tool row is not a call');
    assert.equal(by.agents.objects, 1);
    assert.equal(by.agents.kind, 'agent');
    assert.equal(by.apps.cost, 2, 'the guest row is left out');
    assert.equal(by.apps.people, 1);
    assert.equal(by.automations.cost, 0.5);
    assert.equal(by.chat.cost, 0, 'the direct chat row lies before the period');
    assert.equal(by.media.calls, 0);
    // A source the vocabulary does not know is reported under other, by name.
    assert.deepEqual(by.other.sources, [{ source: 'some_new_source', calls: 1, cost: 0.1 }]);
});

test('people of an area are distinct across its sources and counted on the actor', async () => {
    const out = await kit.store().areas(kit.scope());
    const apps = out.areas.find((a) => a.area === 'apps');
    assert.equal(apps?.people, 1, 'the colleague who ran the app; the owner only paid');
});

test('the timeline has one row per ISO week with every area', async () => {
    const out = await kit.store().areas(kit.scope());
    const weeks = out.timeline.weeks;
    assert.ok(weeks.length >= 5 && weeks.length <= 6);
    for (const w of weeks) assert.deepEqual(Object.keys(w.byArea), [...AREA_IDS]);
    const total = weeks.reduce((sum, w) => sum + w.total, 0);
    assert.equal(Math.round(total * 100) / 100, 3.6);
    assert.equal(weeks.at(-1)?.complete, false, 'the current week is not complete');
});

test('a group narrows the ledger to its members', async () => {
    const out = await kit.store().areas(kit.scope(kit.ORG_A, { groupId: 'a-grp-small' }));
    assert.equal(out.areas.reduce((s, a) => s + a.cost, 0), 0, 'the dormant member caused nothing');
    const big = await kit.store().areas(kit.scope(kit.ORG_A, { groupId: 'a-grp-big' }));
    assert.equal(Math.round(big.areas.reduce((s, a) => s + a.cost, 0) * 100) / 100, 3.6);
});
