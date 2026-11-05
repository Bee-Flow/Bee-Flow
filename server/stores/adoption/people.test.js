'use strict';
/**
 * Adoption per member, against the real schemas (PGlite).
 *
 * Run: cd server && node --test stores/adoption/people.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

test('one row per member, cost first; a run counts for whoever started it', async () => {
    const out = await kit.store().people(kit.scope(), { limit: 50, cursor: 0 });
    assert.equal(out.partial, false);
    assert.equal(out.total, 5);
    assert.equal(out.nextCursor, null);
    const ids = out.people.map((p) => p.id);
    assert.deepEqual(ids.slice(0, 2), ['a-colleague', 'a-owner']);
    const colleague = out.people[0];
    assert.equal(colleague.cost, 2.5);
    assert.equal(colleague.calls, 2);
    assert.deepEqual(colleague.areas, ['apps', 'automations']);
    assert.deepEqual(colleague.built, { meeting: 1 });
    assert.equal(colleague.status, 'ai_active');
    const owner = out.people[1];
    assert.equal(owner.cost, 1.1);
    assert.equal(owner.built.agent, 2);
    assert.equal(owner.built.automation, 1);
    assert.ok(owner.firstAiUseAt, 'the first ledger row ever, the direct chat of 40 days ago');
    assert.ok(Date.parse(owner.firstAiUseAt) < kit.NOW - 39 * kit.DAY);
    assert.ok(ids.every((id) => id.startsWith('a-')), 'nothing of org B, no pending invitation');
    assert.ok(!ids.includes('a-pending'));
});

test('statuses of the others', async () => {
    const out = await kit.store().people(kit.scope(), { limit: 50, cursor: 0 });
    const status = Object.fromEntries(out.people.map((p) => [p.id, p.status]));
    assert.equal(status['a-seen'], 'seen_only');
    assert.equal(status['a-dormant'], 'dormant');
    assert.equal(status['a-new'], 'never');
});

test('pages', async () => {
    const first = await kit.store().people(kit.scope(), { limit: 2, cursor: 0 });
    assert.equal(first.people.length, 2);
    assert.equal(first.nextCursor, 2);
    const last = await kit.store().people(kit.scope(), { limit: 2, cursor: 4 });
    assert.equal(last.people.length, 1);
    assert.equal(last.nextCursor, null);
});
