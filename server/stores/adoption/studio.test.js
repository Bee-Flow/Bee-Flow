'use strict';
/**
 * The organisation's Studio inventory against the real schemas (PGlite).
 *
 * Run: cd server && node --test stores/adoption/studio.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const kit = require('./adoption.testkit');
const { KIND_KEYS } = require('./kinds');

before(kit.setUp, { timeout: 240_000 });
after(kit.tearDown);

test('every kind is listed, in report order, and every query runs against the real schema', async () => {
    const out = await kit.store().studio(kit.scope());
    assert.equal(out.partial, false, 'a kind failed: see the warnings above');
    assert.deepEqual(out.kinds.map((k) => k.kind), [...KIND_KEYS]);
    assert.deepEqual(KIND_KEYS, ['agent', 'automation', 'form', 'app', 'datatable', 'kb', 'skill', 'webpage', 'document', 'meeting', 'playbook', 'solution', 'cowork']);
});

test('counts, makers, published and usage of org A only', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.agent.total, 2);
    assert.equal(k.agent.published, 2);
    assert.equal(k.agent.makers, 1);
    assert.equal(k.agent.newInPeriod, 2);
    assert.deepEqual(k.agent.usage, { events: 1, people: 1, label: 'conversations' });
    // The automation has no organisation of its own: it is the owner's.
    assert.equal(k.automation.total, 1);
    assert.equal(k.automation.newInPeriod, 0);
    assert.deepEqual(k.automation.usage, { events: 1, people: 1, label: 'runs' });
    assert.deepEqual(k.app.usage, { events: 1, people: 1, label: 'action_runs' });
    assert.deepEqual(k.skill.usage, { events: 1, people: 1, label: 'activations' });
    assert.deepEqual(k.meeting.usage, { events: 1, people: 1, label: 'recordings' });
    assert.equal(k.datatable.total, 1);
    assert.equal(k.datatable.usage, null, 'no signal is said, not invented');
    assert.equal(k.webpage.usage?.people, null, 'public views name nobody');
});

test('cost comes from the ledger area of the kind; kinds without an area have none', async () => {
    const out = await kit.store().studio(kit.scope());
    const k = Object.fromEntries(out.kinds.map((r) => [r.kind, r]));
    assert.equal(k.agent.cost, 1);
    assert.equal(k.app.cost, 2, 'the guest row of the public page is not counted');
    assert.equal(k.automation.cost, 0.5);
    assert.equal(k.solution.cost, null);
    assert.equal(k.playbook.cost, null);
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
