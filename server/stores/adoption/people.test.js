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
    assert.deepEqual(colleague.built, { meeting: 2 });
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

test('a builder testing their agent or skill is not adoption: test sources are left out', async () => {
    const { run } = require('../../db');
    await run(`INSERT INTO ai_usage_log (timestamp, user_id, model, source, organization_id, estimated_cost)
               VALUES ($1, 'a-seen', 'm', 'agent_test_chat', $2, 3), ($1, 'a-seen', 'm', 'skill_test_grade', $2, 1)`,
    [kit.at(2), kit.ORG_A]);
    try {
        const out = await kit.store().people(kit.scope(), { limit: 50, cursor: 0 });
        const seen = out.people.find((p) => p.id === 'a-seen');
        assert.equal(seen?.status, 'seen_only');
        assert.equal(seen?.cost, 0);
        assert.equal(seen?.firstAiUseAt, null);
    } finally {
        await run(`DELETE FROM ai_usage_log WHERE user_id = 'a-seen' AND source IN ('agent_test_chat', 'skill_test_grade')`);
    }
});

test('the first AI use is read per person, never by scanning the whole ledger of the organisation', async () => {
    const real = require('../../db');
    /** @type {string[]} */
    const seen = [];
    const db = { ...real, getAll: (sql, params) => { seen.push(sql); return real.getAll(sql, params); } };
    const { createAdoptionStore } = require('../adoptionStore');
    await real.run(`INSERT INTO ai_usage_log (timestamp, user_id, model, source, organization_id, estimated_cost)
                    VALUES ($1, 'a-seen', 'm', 'direct_chat', $2, 0.1)`, [kit.at(500), kit.ORG_A]);
    try {
        const out = await createAdoptionStore({ db, seats: { getMaxSeatsForOrg: async () => 25 } })
            .people(kit.scope(), { limit: 50, cursor: 0 });
        const ledgerReads = seen.filter((sql) => /FROM ai_usage_log/.test(sql));
        assert.ok(ledgerReads.length > 0);
        for (const sql of ledgerReads) {
            assert.ok(/timestamp >= \$/.test(sql) || /ORDER BY l\.timestamp LIMIT 1/.test(sql), `unbounded ledger read: ${sql}`);
        }
        const first = out.people.find((p) => p.id === 'a-seen')?.firstAiUseAt;
        assert.ok(first && Date.parse(first) < kit.NOW - 499 * kit.DAY, 'a first use on the own account is found however old');
    } finally {
        await real.run(`DELETE FROM ai_usage_log WHERE user_id = 'a-seen' AND source = 'direct_chat'`);
    }
});

test('with a group, the answer still names every group of the organisation', async () => {
    const out = await kit.store().people(kit.scope(kit.ORG_A, { groupId: 'a-grp-big' }), { limit: 50, cursor: 0 });
    assert.deepEqual(out.groups.map((g) => g.id), ['a-grp-big']);
    assert.deepEqual(out.allGroups.map((g) => g.id).sort(), ['a-grp-big', 'a-grp-small']);
    assert.ok(out.people.length > 0);
});
