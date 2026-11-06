'use strict';
/**
 * The hero numbers, against the real schemas (PGlite).
 *
 * Run: cd server && node --test stores/adoption/summary.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

test('members, status, makers, spend and seats of org A', async () => {
    const s = await kit.store().summary(kit.scope());
    assert.equal(s.partial, false);
    assert.deepEqual(s.members, {
        total: 5, aiActive: 2, seenOnly: 1, dormant: 1, never: 1, newInPeriod: 1,
        seats: { used: 5, max: 25 },
    });
    // The owner built their first thing 100 days ago; the colleague's first is
    // the meeting of a week ago.
    assert.deepEqual(s.makers, { total: 2, newInPeriod: 1 });
    assert.equal(s.spend.calls, 4);
    assert.equal(s.spend.cost, 3.6);
    assert.equal(s.spend.people, 2);
    assert.equal(s.spend.perActiveMember, 1.8);
    assert.equal(s.adoptionRate, 40);
});

test('the previous period: the direct chat 40 days ago', async () => {
    const s = await kit.store().summary(kit.scope());
    assert.deepEqual(s.prev, { aiActive: 1, adoptionRate: 20, cost: 0.25, calls: 1 });
});

test('an absolute window does not read status off the last-seen clock', async () => {
    const scope = kit.scope();
    const s = await kit.store().summary({ ...scope, period: { ...scope.period, relative: false, days: null } });
    assert.equal(s.members.seenOnly, null);
    assert.equal(s.members.dormant, null);
    assert.equal(s.members.never, null);
    assert.equal(s.range.relative, false);
});

test('a group narrows members and spend', async () => {
    const s = await kit.store().summary(kit.scope(kit.ORG_A, { groupId: 'a-grp-small' }));
    assert.equal(s.members.total, 1);
    assert.equal(s.members.aiActive, 0);
    assert.equal(s.spend.cost, 0);
    assert.equal(s.makers.total, 0);
});
