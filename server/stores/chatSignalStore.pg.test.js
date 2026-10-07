'use strict';

/**
 * chat_signal_counts against a real Postgres (pglite), through the store's
 * own SQL: an additive upsert, a closed vocabulary refused in JS before the
 * charset CHECKs, whole-period retention per org, and a contributor count
 * that is a number and nothing else.
 *
 * Run: cd server && node --test stores/chatSignalStore.pg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { pgliteDb } = require('../testUtils/pgliteDb');
const { DDL, makeChatSignalStore } = require('./chatSignalStore');

const { pg, db } = pgliteDb();
const store = makeChatSignalStore(db);

const MONDAY = '2026-10-05';
const row = (over = {}) => ({
    organization_id: 'org1', period_start: MONDAY, granularity: 'week', surface: 'direct',
    signal: 'outcome', value: 'clean', destination: 'external', provider_type: 'openai', protection: '', turns: 1,
    ...over,
});

let TODAY;
const shift = (n) => new Date(Date.parse(`${TODAY}T00:00:00.000Z`) + n * 86_400_000).toISOString().slice(0, 10);

before(async () => {
    await pg.exec(DDL);
    await pg.exec(DDL);
    await pg.exec(`
        CREATE TABLE compliance_settings (organization_id TEXT PRIMARY KEY, chat_monitoring_retention_days INTEGER);
        CREATE TABLE users (id TEXT PRIMARY KEY, "organizationId" TEXT DEFAULT '');
        CREATE TABLE ai_usage_log (id SERIAL PRIMARY KEY, timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            user_id TEXT, source TEXT, organization_id TEXT);
    `);
    TODAY = (await pg.query(`SELECT CURRENT_DATE::text AS d`)).rows[0].d;
});
after(() => pg.close());

test('the upsert is additive, and rows with the same key in one batch are summed first', async () => {
    assert.equal(await store.addCounts([row(), row({ turns: 2 }), row({ value: 'protected' })]), 2);
    await store.addCounts([row({ turns: 4 })]);
    const { rows } = await pg.query(`SELECT value, turns FROM chat_signal_counts WHERE organization_id = 'org1' ORDER BY value`);
    assert.deepEqual(rows, [{ value: 'clean', turns: 7 }, { value: 'protected', turns: 1 }]);
    assert.equal(await store.addCounts([]), 0);
});

test('a value outside the vocabulary is refused in JS, naming the field and never the value', async () => {
    const cases = [
        [{ value: 'health' }, 'value'],
        [{ signal: 'kind', value: 'health', provider_type: '', protection: 'protected' }, 'value'],
        [{ surface: 'project_chat' }, 'surface'],
        [{ destination: 'mars' }, 'destination'],
        [{ provider_type: 'acme' }, 'provider_type'],
        [{ organization_id: "o'; DROP TABLE x" }, 'organization_id'],
        [{ period_start: '2026-10-06' }, 'period_start'],
        [{ turns: 0 }, 'turns'],
        [{ turns: 1.5 }, 'turns'],
        [{ protection: 'protected' }, 'protection'],
    ];
    for (const [over, field] of cases) {
        await assert.rejects(store.addCounts([row(over)]), (e) => e.message === `chat_signal_invalid:${field}`, JSON.stringify(over));
    }
    const { rows } = await pg.query(`SELECT COUNT(*)::int AS n FROM chat_signal_counts WHERE value = 'health' OR surface = 'project_chat'`);
    assert.equal(rows[0].n, 0, 'one bad row writes nothing');
});

test('free text is refused by the charset CHECK even past the store', async () => {
    await assert.rejects(pg.query(`
        INSERT INTO chat_signal_counts (organization_id, period_start, granularity, surface, signal, value, destination, turns)
        VALUES ('org1', '2026-10-05', 'week', 'direct', 'outcome', 'Jan Jansen wrote this', 'external', 1)`));
    await assert.rejects(pg.query(`
        INSERT INTO chat_signal_counts (organization_id, period_start, granularity, surface, signal, value, destination, turns)
        VALUES ('org1', '2026-10-05', 'week', 'direct', 'outcome', 'clean', 'external', -1)`));
});

test('a kind row never carries a provider; employee surfaces are never daily', async () => {
    await assert.rejects(store.addCounts([row({ signal: 'kind', value: 'email', protection: 'protected' })]), /chat_signal_invalid:provider_type/);
    await store.addCounts([row({ signal: 'kind', value: 'email', provider_type: '', protection: 'exposed' })]);
    await assert.rejects(store.addCounts([row({ granularity: 'day', period_start: '2026-10-07' })]), /chat_signal_invalid:granularity/);
    await assert.rejects(store.addCounts([row({ surface: 'agent_public', granularity: 'week' })]), /chat_signal_invalid:granularity/);
    await store.addCounts([row({ surface: 'agent_public', granularity: 'day', period_start: '2026-10-07' })]);
});

test('reads sum over the window, per surface, and never across orgs', async () => {
    await store.addCounts([
        row({ organization_id: 'org2', turns: 9 }),
        row({ period_start: '2026-09-28', turns: 3 }),
        row({ surface: 'agent', turns: 5 }),
    ]);
    const totals = await store.outcomeTotals('org1', { from: '2026-09-28', to: '2026-10-05', surfaces: ['direct'] });
    assert.deepEqual(totals.find(r => r.value === 'clean'), { surface: 'direct', value: 'clean', destination: 'external', provider_type: 'openai', turns: 10 });
    assert.ok(totals.every(r => r.surface === 'direct'));
    const kinds = await store.kindTotals('org1', { from: '2026-10-05', to: '2026-10-05', surfaces: ['direct'] });
    assert.deepEqual(kinds, [{ surface: 'direct', value: 'email', protection: 'exposed', destination: 'external', turns: 1 }]);
    assert.deepEqual(await store.outcomeTotals('org1', { from: '2026-10-05', to: '2026-10-05', surfaces: ['project_chat'] }), []);
    assert.equal(await store.hasRows('org2'), true);
    assert.equal(await store.hasRows('org9'), false);
});

test('purgeExpired: whole periods, per-org days, the 90 default and the 30/90 clamp', async () => {
    await pg.query(`DELETE FROM chat_signal_counts`);
    await pg.exec(`INSERT INTO compliance_settings VALUES ('a30', 30), ('c10', 10), ('d200', 200)`);
    const raw = async (org, periodStart, granularity = 'week', surface = 'direct') => pg.query(`
        INSERT INTO chat_signal_counts (organization_id, period_start, granularity, surface, signal, value, destination, turns)
        VALUES ($1, $2::date, $3, $4, 'outcome', 'clean', 'external', 1)`, [org, periodStart, granularity, surface]);
    // A week goes once period_start + 7 <= today - days.
    for (const [org, days] of [['a30', 30], ['b-none', 90], ['c10', 30], ['d200', 90]]) {
        await raw(org, shift(-days - 7));          // all of the week is older than the retention: goes
        await raw(org, shift(-days - 6));          // its last day is not: stays
    }
    await raw('a30', shift(-31), 'day', 'agent_public');   // a whole day older than 30 days: goes
    await raw('a30', shift(-30), 'day', 'agent_public');   // stays
    const deleted = await store.purgeExpired();
    assert.equal(deleted, 5);
    const { rows } = await pg.query(`SELECT organization_id, period_start::text AS p, granularity FROM chat_signal_counts ORDER BY organization_id, granularity`);
    assert.deepEqual(rows, [
        { organization_id: 'a30', p: shift(-30), granularity: 'day' },
        { organization_id: 'a30', p: shift(-36), granularity: 'week' },
        { organization_id: 'b-none', p: shift(-96), granularity: 'week' },
        { organization_id: 'c10', p: shift(-36), granularity: 'week' },
        { organization_id: 'd200', p: shift(-96), granularity: 'week' },
    ]);
});

test('contributorCount is a number only, excludes guests and other orgs, and handles the default bucket', async () => {
    await pg.exec(`
        INSERT INTO users VALUES ('u1', 'org1'), ('u2', 'org1'), ('u3', 'org2'), ('u4', ''), ('u5', 'org1');
        INSERT INTO ai_usage_log (timestamp, user_id, source, organization_id) VALUES
            ('2026-10-06T10:00:00Z', 'u1', 'direct_chat', NULL),
            ('2026-10-06T11:00:00Z', 'u1', 'direct_chat', 'org1'),
            ('2026-10-07T10:00:00Z', 'u2', 'swarm', NULL),
            ('2026-10-07T10:00:00Z', 'u3', 'direct_chat', NULL),
            ('2026-10-07T10:00:00Z', 'u4', 'direct_chat', NULL),
            ('2026-10-07T10:00:00Z', 'guest_abc', 'direct_chat', 'org1'),
            ('2026-10-07T10:00:00Z', 'u5', 'notebook', 'org1'),
            ('2026-10-20T10:00:00Z', 'u5', 'direct_chat', 'org1'),
            ('2026-10-07T10:00:00Z', 'u1', 'agent_stream', 'org1'),
            ('2026-10-07T10:00:00Z', 'u3', 'agent_stream', 'org1'),
            ('2026-10-07T10:00:00Z', 'guest_x', 'agent_stream', 'org1');
    `);
    const w = { from: '2026-10-05', toExclusive: '2026-10-12' };
    const direct = await store.contributorCount('org1', 'direct', w);
    assert.equal(direct, 2, 'u1 and u2: not the other org, not the guest, not notebook, not outside the window');
    assert.equal(typeof direct, 'number');
    assert.equal(await store.contributorCount('default', 'direct', w), 1, 'u4 has no organisation');
    assert.equal(await store.contributorCount('org1', 'agent', w), 1, 'u3 is from another org; guests never count');
    assert.equal(await store.contributorCount('org1', 'agent_public', w), null, 'no gate for website visitors');
});

test('deleteAll returns how many rows went', async () => {
    await pg.query(`DELETE FROM chat_signal_counts`);
    await store.addCounts([row(), row({ value: 'blocked' }), row({ organization_id: 'org2' })]);
    assert.equal(await store.deleteAll('org1'), 2);
    assert.equal(await store.hasRows('org1'), false);
    assert.equal(await store.hasRows('org2'), true);
});

test('the columns hold counters and their closed labels only', async () => {
    const { rows } = await pg.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'chat_signal_counts' ORDER BY column_name`);
    assert.deepEqual(rows.map(r => r.column_name), [
        'destination', 'granularity', 'organization_id', 'period_start', 'protection', 'provider_type', 'signal', 'surface', 'turns', 'value',
    ]);
});
