/**
 * Risk store tests — score computation, field whitelisting, acceptance stamps,
 * seed dedupe, stats aggregation.
 * Fake db injected via require.cache (same pattern as soaStore.test.js).
 *
 * Run: cd server && node --test stores/riskStore.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const calls = { run: [], getOne: [], getAll: [] };
let oneResult = null;
let allResult = [];

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => { calls.run.push({ sql, params }); return { rowCount: 1, rows: [] }; },
    getOne: async (sql, params) => { calls.getOne.push({ sql, params }); return oneResult; },
    getAll: async (sql, params) => { calls.getAll.push({ sql, params }); return allResult; },
};
const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

const riskStore = require('./riskStore');

beforeEach(() => {
    calls.run.length = 0;
    calls.getOne.length = 0;
    calls.getAll.length = 0;
    oneResult = null;
    allResult = [];
});

test('createRisk computes score = likelihood × impact in the store', async () => {
    await riskStore.createRisk('orgA', {
        title: 'Prompt-injection exfiltration',
        category: 'confidentiality',
        likelihood: 4,
        impact: 5,
    }, 'actor1');
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_risks'));
    assert.ok(insert, 'insert issued');
    // [orgId, title, description, category, likelihood, impact, score, status, owner, source, seed_key, review_due, created_by]
    assert.strictEqual(insert.params[4], 4, 'likelihood');
    assert.strictEqual(insert.params[5], 5, 'impact');
    assert.strictEqual(insert.params[6], 20, 'score is computed 4×5=20');
    assert.strictEqual(insert.params[7], 'open', 'default status');
    assert.strictEqual(insert.params[9], 'manual', 'default source');
    assert.strictEqual(insert.params[12], 'actor1', 'created_by = actor');
});

test('createRisk clamps out-of-range scales and ignores a client-supplied score', async () => {
    await riskStore.createRisk('orgA', { title: 'X', likelihood: 99, impact: -3, score: 25 }, null);
    const insert = calls.run.find(c => c.sql.includes('INSERT INTO iso_risks'));
    assert.strictEqual(insert.params[4], 5, 'likelihood clamped to 5');
    assert.strictEqual(insert.params[5], 1, 'impact clamped to 1');
    assert.strictEqual(insert.params[6], 5, 'score recomputed (5×1), client score ignored');
});

test('updateRisk whitelists fields, drops unknown ones, recomputes score', async () => {
    oneResult = {
        id: 7, organization_id: 'orgA', title: 'Old title', description: 'old', category: 'integrity',
        likelihood: 2, impact: 2, score: 4, status: 'open',
        owner_user_id: 'zoe', review_due_at: null, accepted_by: null, accepted_at: null,
    };
    await riskStore.updateRisk('orgA', 7, {
        likelihood: 5,
        evil_field: 'DROP TABLE iso_risks',
        accepted_by: 'mallory',
        accepted_at: '2020-01-01',
    }, 'actor2');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_risks'));
    assert.ok(upd, 'update issued');
    assert.ok(!upd.sql.includes('evil_field'), 'unknown fields never reach SQL');
    // [orgId, id, title, description, category, likelihood, impact, score, status, owner, review_due, stampAcceptance, actor]
    assert.strictEqual(upd.params[2], 'Old title', 'omitted fields keep existing values');
    assert.strictEqual(upd.params[5], 5, 'patched likelihood');
    assert.strictEqual(upd.params[6], 2, 'existing impact kept');
    assert.strictEqual(upd.params[7], 10, 'score recomputed 5×2=10');
    assert.strictEqual(upd.params[11], false, 'no acceptance stamp without status change');
    assert.ok(!upd.params.includes('mallory'), 'client cannot set accepted_by');
});

test('updateRisk status→accepted stamps accepted_by/at from the actor', async () => {
    oneResult = {
        id: 8, organization_id: 'orgA', title: 'T', description: null, category: null,
        likelihood: 3, impact: 3, score: 9, status: 'treating',
        owner_user_id: null, review_due_at: null, accepted_by: null, accepted_at: null,
    };
    await riskStore.updateRisk('orgA', 8, { status: 'accepted' }, 'ciso-user');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_risks'));
    assert.strictEqual(upd.params[8], 'accepted');
    assert.strictEqual(upd.params[11], true, 'acceptance stamp flag set');
    assert.strictEqual(upd.params[12], 'ciso-user', 'accepted_by = acting user');
    assert.ok(upd.sql.includes("CASE WHEN $12 THEN NOW() ELSE accepted_at END"), 'accepted_at stamped server-side');
});

test('updateRisk never overwrites an existing acceptance stamp', async () => {
    oneResult = {
        id: 9, organization_id: 'orgA', title: 'T', description: null, category: null,
        likelihood: 3, impact: 3, score: 9, status: 'accepted',
        owner_user_id: null, review_due_at: null, accepted_by: 'first-ciso', accepted_at: '2026-01-01T00:00:00Z',
    };
    await riskStore.updateRisk('orgA', 9, { status: 'accepted' }, 'second-actor');
    const upd = calls.run.find(c => c.sql.includes('UPDATE iso_risks'));
    assert.strictEqual(upd.params[11], false, 'already accepted → stamp flag stays false');
});

test('seedMissing dedupes on seed_key via ON CONFLICT DO NOTHING and skips invalid seeds', async () => {
    const seeds = [
        { seed_key: 'llm_exfil', title: 'LLM data exfiltration', category: 'confidentiality', likelihood: 3, impact: 4 },
        { seed_key: 'backup_fail', title: 'Backup restore fails', category: 'availability' },
        { title: 'No seed key' },      // skipped — not dedupable
        { seed_key: 'no_title' },      // skipped — no title
    ];
    const n = await riskStore.seedMissing('orgA', seeds);
    assert.strictEqual(n, 2, 'only valid seeds inserted');
    assert.strictEqual(calls.run.length, 2);
    for (const c of calls.run) {
        assert.ok(
            c.sql.includes('ON CONFLICT (organization_id, seed_key) WHERE seed_key IS NOT NULL DO NOTHING'),
            'seed insert must dedupe on the partial unique index and never overwrite'
        );
    }
    // [orgId, title, description, category, likelihood, impact, score, seed_key]
    assert.strictEqual(calls.run[0].params[6], 12, 'seed score computed 3×4');
    assert.strictEqual(calls.run[0].params[7], 'llm_exfil');
    assert.strictEqual(calls.run[1].params[6], 9, 'defaults 3×3 when scales omitted');
});

test('getStats returns the aggregate row and safe zeros when empty', async () => {
    oneResult = { total: 12, open: 4, treating: 3, accepted: 2, closed: 3, high: 5, overdue_reviews: 1 };
    const stats = await riskStore.getStats('orgA');
    assert.deepEqual(stats, { total: 12, open: 4, treating: 3, accepted: 2, closed: 3, high: 5, overdue_reviews: 1 });
    const q = calls.getOne.find(c => c.sql.includes('FROM iso_risks'));
    assert.ok(q.sql.includes("score >= $2 AND status <> 'closed'"), 'high band counts active risks only');
    assert.strictEqual(q.params[1], riskStore.HIGH_SCORE);

    oneResult = null;
    const empty = await riskStore.getStats('orgB');
    assert.deepEqual(empty, { total: 0, open: 0, treating: 0, accepted: 0, closed: 0, high: 0, overdue_reviews: 0 });
});
