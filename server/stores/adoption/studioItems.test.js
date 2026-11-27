'use strict';
/**
 * The drill-down of one Studio kind against the real schemas (PGlite): the
 * core's kinds. A module's kinds are tested next to its part (kinds.<module>.test.js).
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

test('org B sees its own objects, never A\'s', async () => {
    const out = await kit.store().studioItems(kit.scope(kit.ORG_B), 'agent', 50);
    assert.deepEqual(out.items.map((i) => i.id).sort(), ['b-agent', 'b-agent2']);
    const unknown = await kit.store().studioItems(kit.scope('org-nobody'), 'agent', 50);
    assert.equal(unknown?.total, 0);
});

test('an unknown kind answers null', async () => {
    assert.equal(await kit.store().studioItems(kit.scope(), 'nope', 50), null);
});

test('a kind whose module is not part of this installation answers null too', async () => {
    const registry = require('../../core/featureModules');
    const name = 'stores/adoption/kinds.playbooks';
    registry.optionalFeatureModule(name);
    const previous = registry._featureModuleGetter(name);
    registry.registerFeatureModules({ [name]: () => ({ KINDS: [] }) });
    try {
        assert.equal(await kit.store().studioItems(kit.scope(), 'playbook', 50), null);
    } finally {
        if (previous) registry.registerFeatureModules({ [name]: previous });
        else registry._clearFeatureModulesForTests(name);
    }
});


test('private items are counted, never listed: no title of a private document leaves the store', async () => {
    const docs = await kit.store().studioItems(kit.scope(), 'document', 50);
    assert.equal(docs?.total, 1);
    assert.deepEqual(docs?.items, []);
    assert.deepEqual(docs?.unused, []);
    const body = JSON.stringify([docs]);
    assert.ok(!body.includes('Private notes'), 'no private title anywhere in the answer');
    assert.ok(!body.includes('a-doc-private'), 'nor its id');
});

test('with a group, uses, people, cost and top people narrow to its members; the objects stay listed', async () => {
    // a-grp-small holds only the dormant member, who used nothing.
    const out = await kit.store().studioItems(kit.scope(kit.ORG_A, { groupId: 'a-grp-small' }), 'agent', 50);
    assert.equal(out?.total, 2);
    const agent = out?.items.find((i) => i.id === 'a-agent');
    assert.equal(agent?.uses, 0);
    assert.equal(agent?.people, 0);
    assert.equal(agent?.cost, 0);
    assert.deepEqual(out?.topPeople, []);
    const big = await kit.store().studioItems(kit.scope(kit.ORG_A, { groupId: 'a-grp-big' }), 'agent', 50);
    assert.equal(big?.items.find((i) => i.id === 'a-agent')?.uses, 1, 'the colleague is in the big group');
});

test('the platform operator is nobody\'s member: not counted among the people of the evidence', async () => {
    const { run } = require('../../db');
    const { PLATFORM_OPERATOR_ID } = require('../../auth/platformOperator');
    await run(`INSERT INTO agent_conversations (id, agent_id, user_id, updated_at) VALUES ('a-conv-op1', 'a-agent', $1, $2), ('a-conv-op2', 'a-agent', $1, $2)`,
        [PLATFORM_OPERATOR_ID, kit.at(2)]);
    try {
        const out = await kit.store().studioItems(kit.scope(), 'agent', 50);
        assert.equal(out?.items.find((i) => i.id === 'a-agent')?.people, 1);
        assert.ok(!out?.topPeople.some((p) => p.person === PLATFORM_OPERATOR_ID));
        const studio = await kit.store().studio(kit.scope());
        assert.equal(studio.kinds.find((k) => k.kind === 'agent')?.usage?.people, 1);
    } finally {
        await run(`DELETE FROM agent_conversations WHERE id IN ('a-conv-op1', 'a-conv-op2')`);
    }
});

test('a top user by uses keeps their real cost when they do not rank among the costliest; owner names are read for the answer only, without avatars', async () => {
    const real = require('../../db');
    const org = 'org-adopt-c';
    await real.run(`INSERT INTO agents (id, name, owner_id, organization_id, is_published, created_at)
                    VALUES ('c-agent', 'Busy', 'c-o1', $1, TRUE, $2), ('c-agent-b', 'Costly', 'c-o2', $1, TRUE, $2)`, [org, kit.at(10)]);
    await real.run(`INSERT INTO agent_conversations (id, agent_id, user_id, updated_at)
                    VALUES ('c-c1', 'c-agent', 'c-heavy', $1), ('c-c2', 'c-agent', 'c-heavy', $1), ('c-c3', 'c-agent', 'c-heavy', $1),
                           ('c-c4', 'c-agent-b', 'c-p1', $1)`, [kit.at(2)]);
    await real.run(`INSERT INTO ai_usage_log (timestamp, user_id, agent_id, model, source, organization_id, estimated_cost)
                    VALUES ($1, 'c-heavy', 'c-agent', 'cheap', 'agent_stream', $2, 0.01)`, [kit.at(2), org]);
    for (let i = 1; i <= 21; i++) {
        await real.run(`INSERT INTO ai_usage_log (timestamp, user_id, agent_id, model, source, organization_id, estimated_cost)
                        VALUES ($1, $2, 'c-agent-b', 'dear', 'agent_stream', $3, 1)`, [kit.at(2), `c-p${i}`, org]);
    }
    /** @type {Array<{ sql: string, params: unknown[] }>} */
    const reads = [];
    const db = { ...real, getAll: (sql, params) => { reads.push({ sql, params }); return real.getAll(sql, params); } };
    const userStore = { ...require('../userStore'), getUserAvatarsByIds: () => { throw new Error('the avatar is not read'); } };
    const { createAdoptionStore } = require('../adoptionStore');
    const out = await createAdoptionStore({ db, userStore }).studioItems(kit.scope(org), 'agent', 1);
    assert.deepEqual(out?.topPeople[0], { person: 'c-heavy', uses: 3, cost: 0.01 });
    assert.deepEqual(out?.items.map((i) => i.id), ['c-agent']);
    const names = reads.filter((r) => /FROM users WHERE/.test(r.sql));
    assert.equal(names.length, 1);
    assert.doesNotMatch(names[0].sql, /avatar/);
    assert.deepEqual(names[0].params, [['c-o1']], 'only the owner of the item returned');
});
