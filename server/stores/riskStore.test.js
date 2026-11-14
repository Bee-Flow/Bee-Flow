// @typecheck
/**
 * Risk store against a real Postgres (PGlite behind db.js's pool,
 * testUtils/pglitePool.js, with the store's own schema): the score is computed
 * in the store, fields are whitelisted, the acceptance stamp comes from the
 * actor and is never overwritten, seeds dedupe on seed_key, and the stats
 * count active high risks only.
 *
 * Run: cd server && node --test stores/riskStore.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const riskStore = require('./riskStore');

before(() => riskStore.initDB());
after(close);

test('createRisk computes score = likelihood × impact in the store, with defaults', async () => {
    const r = await riskStore.createRisk('orgA', { title: 'Prompt-injection exfiltration', category: 'confidentiality', likelihood: 4, impact: 5 }, 'actor1');
    assert.deepStrictEqual([r.likelihood, r.impact, r.score, r.status, r.source, r.created_by], [4, 5, 20, 'open', 'manual', 'actor1']);
});

test('createRisk clamps out-of-range scales and ignores a client-supplied score', async () => {
    const r = await riskStore.createRisk('orgA', /** @type {any} */ ({ title: 'X', likelihood: 99, impact: -3, score: 25 }), null);
    assert.deepStrictEqual([r.likelihood, r.impact, r.score], [5, 1, 5]);
});

test('updateRisk whitelists fields, keeps omitted ones, recomputes the score, and never takes acceptance from the client', async () => {
    const r = await riskStore.createRisk('orgA', { title: 'Old title', description: 'old', category: 'integrity', likelihood: 2, impact: 2 }, 'zoe');
    await riskStore.updateRisk('orgA', r.id, /** @type {any} */ ({
        likelihood: 5, evil_field: 'DROP TABLE iso_risks', accepted_by: 'mallory', accepted_at: '2020-01-01',
    }), 'actor2');
    const after = await riskStore.getRisk('orgA', r.id);
    assert.deepStrictEqual([after.title, after.description, after.likelihood, after.impact, after.score], ['Old title', 'old', 5, 2, 10]);
    assert.strictEqual(after.accepted_by, null, 'client cannot set accepted_by');
    assert.strictEqual(after.accepted_at, null);
});

test('updateRisk status → accepted stamps accepted_by/at from the actor, and never overwrites an existing stamp', async () => {
    const r = await riskStore.createRisk('orgA', { title: 'T', likelihood: 3, impact: 3, status: 'treating' }, null);
    await riskStore.updateRisk('orgA', r.id, { status: 'accepted' }, 'ciso-user');
    const first = await riskStore.getRisk('orgA', r.id);
    assert.strictEqual(first.status, 'accepted');
    assert.strictEqual(first.accepted_by, 'ciso-user');
    assert.ok(first.accepted_at, 'stamped server-side');

    await riskStore.updateRisk('orgA', r.id, { status: 'accepted' }, 'second-actor');
    const again = await riskStore.getRisk('orgA', r.id);
    assert.strictEqual(again.accepted_by, 'ciso-user');
    assert.strictEqual(new Date(again.accepted_at).getTime(), new Date(first.accepted_at).getTime());
});

test('updateRisk never reaches a risk of another organisation', async () => {
    const theirs = await riskStore.createRisk('orgB', { title: 'Theirs', likelihood: 1, impact: 1 }, null);
    await riskStore.updateRisk('orgA', theirs.id, { title: 'hijacked', likelihood: 5 }, 'x');
    const stored = await riskStore.getRisk('orgB', theirs.id);
    assert.deepStrictEqual([stored.title, stored.likelihood], ['Theirs', 1]);
    assert.strictEqual(await riskStore.getRisk('orgA', theirs.id), null);
});

test('seedMissing inserts valid seeds once, never overwrites, and skips seeds without a key or title', async () => {
    const seeds = [
        { seed_key: 'llm_exfil', title: 'LLM data exfiltration', category: 'confidentiality', likelihood: 3, impact: 4 },
        { seed_key: 'backup_fail', title: 'Backup restore fails', category: 'availability' },
        { title: 'No seed key' },
        { seed_key: 'no_title' },
    ];
    assert.strictEqual(await riskStore.seedMissing('orgSeed', seeds), 2, 'only valid seeds inserted');
    await pg.query("UPDATE iso_risks SET title = 'Renamed by the org' WHERE organization_id = 'orgSeed' AND seed_key = 'llm_exfil'");
    assert.strictEqual(await riskStore.seedMissing('orgSeed', seeds), 0, 'a second run adds nothing');
    const rows = (await pg.query("SELECT seed_key, title, score FROM iso_risks WHERE organization_id = 'orgSeed' ORDER BY seed_key")).rows;
    assert.deepStrictEqual(rows, [
        { seed_key: 'backup_fail', title: 'Backup restore fails', score: 9 },
        { seed_key: 'llm_exfil', title: 'Renamed by the org', score: 12 },
    ]);
    assert.strictEqual(await riskStore.seedMissing('orgSeed2', seeds), 2, 'another organisation gets its own seeds');
});

test('getStats aggregates per organisation; the high band counts active risks only; zeros when empty', async () => {
    const org = 'orgStats';
    await riskStore.createRisk(org, { title: 'a', likelihood: 5, impact: 5 }, null);
    await riskStore.createRisk(org, { title: 'b', likelihood: 4, impact: 3, status: 'treating' }, null);
    await riskStore.createRisk(org, { title: 'c', likelihood: 5, impact: 4, status: 'closed' }, null);
    await riskStore.createRisk(org, { title: 'd', likelihood: 1, impact: 2 }, null);
    const stats = await riskStore.getStats(org);
    assert.strictEqual(riskStore.HIGH_SCORE, 10);
    assert.deepStrictEqual({ ...stats, overdue_reviews: undefined }, { total: 4, open: 2, treating: 1, accepted: 0, closed: 1, high: 2, overdue_reviews: undefined });
    assert.deepStrictEqual(await riskStore.getStats('orgEmpty'), { total: 0, open: 0, treating: 0, accepted: 0, closed: 0, high: 0, overdue_reviews: 0 });
});
