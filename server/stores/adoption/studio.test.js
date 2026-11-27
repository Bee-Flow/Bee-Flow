'use strict';
/**
 * The organisation's Studio inventory against the real schemas (PGlite): the
 * core's kinds. A module's kinds are tested next to its part (kinds.<module>.test.js).
 *
 * Run: cd server && node --test stores/adoption/studio.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');
const { KIND_KEYS, kindKeys } = require('./kinds');

/** The module that declares each kind of a module (stores/adoption/kinds.<module>.js); the rest are the core's. */
const MODULE_OF_KIND = { automation: 'automation', form: 'automation', app: 'apps', datatable: 'datatables', webpage: 'webpages', meeting: 'meetingNotes', playbook: 'playbooks', cowork: 'cowork' };

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

// About the composition: every kind of the core, and every kind of each module that is here.
test('every kind is listed, in report order, and every query runs against the real schema', async () => {
    const out = await kit.store().studio(kit.scope());
    assert.equal(out.partial, false, 'a kind failed: see the warnings above');
    assert.deepEqual(out.kinds.map((k) => k.kind), kindKeys());
    assert.deepEqual(KIND_KEYS, ['agent', 'automation', 'form', 'app', 'datatable', 'kb', 'skill', 'webpage', 'document', 'meeting', 'playbook', 'solution', 'cowork']);
    const here = KIND_KEYS.filter((k) => kit.loaded(MODULE_OF_KIND[k] ?? null));
    assert.deepEqual(kindKeys(), here, 'a kind whose module is not here is left out, the order kept');
});

test('a module\'s kinds come from its part, asked for by name, in their place in the order', async () => {
    const registry = require('../../core/featureModules');
    const name = 'stores/adoption/kinds.cowork';
    registry.optionalFeatureModule(name);
    const previous = registry._featureModuleGetter(name);
    const { objectsSql } = require('./kindSql');
    const double = {
        kind: 'cowork',
        objects: objectsSql(`o.id, o.name, o.owner_id AS owner, o.created_at, FALSE AS published, 'private' AS audience,
            NULL::timestamptz AS published_at`, 'FROM agents o JOIN users u ON u.id = o.owner_id', 'u."organizationId" = $1'),
        evidence: null, label: null, peopleKnown: false, itemCost: false,
    };
    registry.registerFeatureModules({ [name]: () => ({ KINDS: [double] }) });
    try {
        const out = await kit.store().studio(kit.scope());
        assert.equal(out.kinds.at(-1)?.kind, 'cowork', 'the last kind of the report');
        assert.equal(out.kinds.at(-1)?.total, 2, 'its SQL ran: the two agents of org A');
        assert.equal(out.kinds.at(-1)?.usage, null);
    } finally {
        if (previous) registry.registerFeatureModules({ [name]: previous });
        else registry._clearFeatureModulesForTests(name);
    }
});

test('counts, makers, published and usage of org A only', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.agent.total, 2);
    assert.equal(k.agent.published, 2);
    assert.equal(k.agent.makers, 1);
    assert.equal(k.agent.newInPeriod, 2);
    assert.deepEqual(k.agent.usage, { events: 1, people: 1, label: 'conversations' });
    assert.deepEqual(k.skill.usage, { events: 1, people: 1, label: 'activations' });
    assert.equal(k.document.total, 1, 'a private document is counted in the inventory');
});

test('cost comes from the ledger area of the kind; kinds without an area have none', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.agent.cost, 1);
    assert.equal(k.solution.cost, null);
    // One value per ISO week of the period.
    const weeks = require('./shared').isoWeeksOf(kit.scope().period.startDate, kit.scope().period.endDate, kit.NOW);
    for (const row of out.kinds) assert.equal(row.trend.length, weeks.length, row.kind);
    assert.equal(k.agent.trend.reduce((a, b) => a + b, 0), 1);
});

test('a kind whose table is missing drops to zeros and marks the answer partial', async () => {
    const real = require('../../db');
    const db = {
        ...real,
        getOne: (sql, params) => (/FROM skills/.test(sql) ? Promise.reject(new Error('relation missing')) : real.getOne(sql, params)),
        getAll: (sql, params) => (/FROM skills/.test(sql) ? Promise.reject(new Error('relation missing')) : real.getAll(sql, params)),
    };
    const { createAdoptionStore } = require('../adoptionStore');
    const out = await createAdoptionStore({ db }).studio(kit.scope());
    assert.equal(out.partial, true);
    const skill = out.kinds.find((k) => k.kind === 'skill');
    assert.equal(skill?.total, 0);
    assert.equal(out.kinds.find((k) => k.kind === 'agent')?.total, 2, 'the other kinds still answer');
});

test('with a group, usage, cost, trend and delta narrow to its members; the inventory stays organisation-wide', async () => {
    // a-grp-small holds only the dormant member, who used nothing.
    const out = await kit.store().studio(kit.scope(kit.ORG_A, { groupId: 'a-grp-small' }));
    assert.equal(out.partial, false);
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.agent.total, 2, 'what exists is the organisation\'s');
    assert.equal(k.agent.makers, 1);
    assert.deepEqual(k.agent.usage, { events: 0, people: 0, label: 'conversations' });
    assert.equal(k.agent.cost, 0);
    assert.equal(k.agent.trend.reduce((a, b) => a + b, 0), 0);
    const big = await kit.store().studio(kit.scope(kit.ORG_A, { groupId: 'a-grp-big' }));
    const b = Object.fromEntries(big.kinds.map((r) => [r.kind, r]));
    assert.equal(b.agent.usage?.events, 1);
});
