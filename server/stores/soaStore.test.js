/**
 * SoA store tests — field whitelisting, seed-never-overwrites, stats shape.
 * Fake db injected via require.cache (same pattern as incidentStore.test.js).
 *
 * Run: cd server && node --test stores/soaStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const calls = { run: [], getOne: [], getAll: [] };
let oneResult = null;
let allResult = [];

const execCalls = [];
const mockDb = {
    exec: async (sql) => { execCalls.push(sql); },
    run: async (sql, params) => { calls.run.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async (sql, params) => { calls.getOne.push({ sql, params }); return oneResult; },
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return allResult; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const soaStore = require('./soaStore');

beforeEach(() => {
    calls.run.length = 0;
    calls.getOne.length = 0;
    calls.getAll.length = 0;
    oneResult = null;
    allResult = [];
});

test('upsertEntry whitelists fields and applies safe defaults', async () => {
    oneResult = null; // no existing row
    await soaStore.upsertEntry('orgA', 'A.5.15', {
        applicable: false,
        justification: 'covered elsewhere',
        source: 'not-a-source',
        status: 'not-a-status',
        owner_user_id: 'jan',
        evil_field: 'DROP TABLE',
    }, 'actor1');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.ok(insert, 'upsert INSERT issued');
    // [orgId, ref, applicable, justification, source, status, owner, evidence_ref, actor]
    assert.deepEqual(insert.params.slice(0, 7), ['orgA', 'A.5.15', false, 'covered elsewhere', 'attest', 'todo', 'jan']);
    assert.strictEqual(insert.params[8], 'actor1');
    assert.ok(!insert.sql.includes('evil_field'), 'unknown fields never reach SQL');
});

test('upsertEntry preserves existing values when patch omits them', async () => {
    oneResult = { organization_id: 'orgA', control_ref: 'A.8.24', applicable: true, justification: 'crypto', source: 'auto', status: 'approved', owner_user_id: 'zoe', evidence_ref: 'ev1' };
    await soaStore.upsertEntry('orgA', 'A.8.24', { status: 'reviewed' }, 'actor2');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.deepEqual(insert.params.slice(2, 8), [true, 'crypto', 'auto', 'reviewed', 'zoe', 'ev1']);
});

test('seedMissing inserts with DO NOTHING and counts only real inserts', async () => {
    const seeds = [
        { control_ref: 'A.5.1', source: 'attest' },
        { control_ref: 'A.7.1', source: 'inherited', justification: 'IaaS-inherited' },
        { control_ref: null }, // skipped
    ];
    const n = await soaStore.seedMissing('orgA', seeds, 'actor3');
    assert.strictEqual(n, 2);
    for (const c of calls.run) {
        assert.ok(c.sql.includes('DO NOTHING'), 'seed must never overwrite an existing decision');
    }
    assert.deepEqual(calls.run[1].params.slice(0, 5), ['orgA', 'A.7.1', true, 'IaaS-inherited', 'inherited']);
});

test('seedMissing rejects unknown sources back to attest', async () => {
    await soaStore.seedMissing('orgA', [{ control_ref: 'A.5.2', source: 'wild' }], null);
    assert.strictEqual(calls.run[0].params[4], 'attest');
});

test('getStats aggregates status counts and exclusions', async () => {
    allResult = [
        { status: 'approved', applicable: true, n: 40 },
        { status: 'reviewed', applicable: true, n: 20 },
        { status: 'todo', applicable: true, n: 23 },
        { status: 'todo', applicable: false, n: 10 },
    ];
    const stats = await soaStore.getStats('orgA');
    assert.deepEqual(stats, { total: 93, approved: 40, reviewed: 20, todo: 33, excluded: 10 });
});

// ── how_met (Compliance Center redesign) ─────────────────────────────────

test('boot DDL adds how_met additively', async () => {
    await soaStore.initDB();
    assert.ok(execCalls.some(sql => /ALTER TABLE iso_soa_entries ADD COLUMN IF NOT EXISTS how_met TEXT/.test(sql)), 'how_met column');
});

test('upsertEntry accepts how_met as the last bind, caps it, and clears it on an explicit empty string', async () => {
    oneResult = null;
    await soaStore.upsertEntry('orgA', 'A.5.15', { how_met: 'MFA enforced at the IdP; break-glass account in the vault' }, 'actor1');
    let insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.strictEqual(insert.params.length, 10);
    assert.strictEqual(insert.params[9], 'MFA enforced at the IdP; break-glass account in the vault');
    assert.ok(insert.sql.includes('how_met = EXCLUDED.how_met'), 'the upsert carries how_met into the conflict branch');
    assert.deepEqual(insert.params.slice(0, 7), ['orgA', 'A.5.15', true, null, 'attest', 'todo', null], 'v1 positions unchanged');

    calls.run.length = 0;
    await soaStore.upsertEntry('orgA', 'A.5.15', { how_met: 'x'.repeat(5000) }, 'actor1');
    insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.strictEqual(insert.params[9].length, 4000, 'capped');

    calls.run.length = 0;
    await soaStore.upsertEntry('orgA', 'A.5.15', { how_met: '' }, 'actor1');
    insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.strictEqual(insert.params[9], null, 'explicit empty clears');
});

test('upsertEntry keeps the existing how_met when the patch omits it', async () => {
    oneResult = { organization_id: 'orgA', control_ref: 'A.8.24', applicable: true, justification: 'crypto', source: 'auto', status: 'approved', owner_user_id: 'zoe', evidence_ref: 'ev1', how_met: 'AES-256-GCM envelope encryption' };
    await soaStore.upsertEntry('orgA', 'A.8.24', { status: 'reviewed' }, 'actor2');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_soa_entries'));
    assert.strictEqual(insert.params[9], 'AES-256-GCM envelope encryption');
});
