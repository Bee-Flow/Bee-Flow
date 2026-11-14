// @typecheck
/**
 * The root_run_id migration: an idempotent ADD COLUMN, two indexes, and a
 * one-shot backfill that reconstructs journeys from history. On a real
 * Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js) with the
 * automation_runs columns the migration reads.
 *
 * Three things are held here because the automation store replays every
 * migration on every boot:
 *   (a) the DDL is idempotent — a second boot must not fail;
 *   (b) the backfill runs only when something still lacks a root, so a normal
 *       boot does not build a recursive CTE over the whole runs table;
 *   (c) the journey index is on the COALESCE EXPRESSION, not on the bare
 *       column. Every journey query asks for COALESCE(root_run_id, id) so that
 *       rows predating the column keep matching themselves, and a plain b-tree
 *       on root_run_id cannot answer that.
 *
 * Run: node --test migrations/automation-run-root-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { usePglitePool } = require('../testUtils/pglitePool');
const { insertRow } = require('../testUtils/pgliteSeed');

const { pg, close } = usePglitePool();
const migration = require('./automation-run-root-2026-08');
test.after(close);

test.beforeEach(async () => {
    await pg.exec(`DROP TABLE IF EXISTS automation_runs;
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, trigger_kind TEXT NOT NULL,
            parent_run_id TEXT, summary TEXT, started_at TIMESTAMPTZ DEFAULT NOW())`);
});

/** @param {string} id @param {Record<string, unknown>} [over] */
const runRow = (id, over = {}) => insertRow(pg, 'automation_runs', { id, user_id: 'u1', trigger_kind: 'manual', ...over });
const roots = async () => Object.fromEntries((await pg.query('SELECT id, root_run_id FROM automation_runs ORDER BY id')).rows.map(r => [r.id, r.root_run_id]));

/** The statements db.js sends while `fn` runs. @param {() => Promise<unknown>} fn */
async function recordStatements(fn) {
    const db = require('../db');
    const saved = db.pool.query;
    /** @type {string[]} */
    const sent = [];
    db.pool.query = /** @type {any} */ ((/** @type {any} */ sql, /** @type {any} */ params) => { sent.push(String(sql).replace(/\s+/g, ' ').trim()); return saved(sql, params); });
    try { await fn(); } finally { db.pool.query = saved; }
    return sent;
}

test('adds the nullable column, idempotently', async () => {
    await migration.up();
    await migration.up();
    const { rows } = await pg.query("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name = 'automation_runs' AND column_name = 'root_run_id'");
    assert.deepEqual(rows, [{ is_nullable: 'YES', data_type: 'text' }]);
});

test('indexes the COALESCE expression the journey queries actually use', async () => {
    await migration.up();
    await migration.up();
    const { rows } = await pg.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'automation_runs' AND indexname LIKE 'idx_automation_runs_%' ORDER BY 1");
    assert.deepEqual(rows.map(r => r.indexname), ['idx_automation_runs_journey', 'idx_automation_runs_user_heads']);
    const [journey, heads] = rows.map(r => r.indexdef);
    assert.ok(journey.includes('btree (COALESCE(root_run_id, id), started_at DESC, id DESC)'), journey);
    assert.ok(heads.includes('(user_id, started_at DESC, id DESC)') && heads.includes('root_run_id = id'), heads);
});

test('the backfill is skipped once every run has a root', async () => {
    await runRow('a');
    await migration.up();
    const sent = await recordStatements(() => migration.up());
    assert.ok(!sent.some(s => s.includes('WITH RECURSIVE')), 'no CTE on an ordinary boot');
    assert.ok(!sent.some(s => s.startsWith('UPDATE automation_runs')), 'no table-wide UPDATE on an ordinary boot');
});

test('the backfill only follows a link the parent NAMES or shares a trigger with', async () => {
    // parent_run_id is set by retries and by partial "▶ Execute from here" runs
    // as well as by continuations, and only the summary marker distinguishes
    // them in history. Matching the phrase alone would let a partial run —
    // parented onto whatever ran last — be swallowed into a stranger's journey.
    await runRow('head', { trigger_kind: 'webhook', summary: 'Resumed after approval — see child run named' });
    await runRow('named', { trigger_kind: 'approval', parent_run_id: 'head', summary: 'Resumed again — see child run grandchild' });
    await runRow('grandchild', { trigger_kind: 'manual', parent_run_id: 'named' });
    await runRow('sibling', { trigger_kind: 'webhook', parent_run_id: 'head' });
    await runRow('partial', { trigger_kind: 'manual', parent_run_id: 'head' });
    await runRow('retry', { trigger_kind: 'manual', parent_run_id: 'plain' });
    await runRow('plain', { trigger_kind: 'manual', summary: 'done' });
    await migration.up();
    assert.deepEqual(await roots(), {
        head: 'head',
        named: 'head',           // the parent names it
        grandchild: 'head',      // the walk recurses through a named child
        sibling: 'head',         // shares the parent's trigger
        partial: 'partial',      // a partial run parented onto the head is its own journey
        retry: 'retry',          // the parent is no handoff
        plain: 'plain',
    });
});

test('anything the walk missed roots itself, so the probe goes quiet', async () => {
    await runRow('old', { started_at: new Date(Date.now() - 200 * 86400e3).toISOString() });
    await runRow('loop-a', { parent_run_id: 'loop-b', summary: 'Resumed — see child run loop-b' });
    await runRow('loop-b', { parent_run_id: 'loop-a', summary: 'Resumed — see child run loop-a' });
    await migration.up();
    assert.deepEqual(await roots(), { 'loop-a': 'loop-a', 'loop-b': 'loop-b', old: 'old' });
    const { rows } = await pg.query('SELECT 1 FROM automation_runs WHERE root_run_id IS NULL');
    assert.equal(rows.length, 0, 'without this the walk would re-run on every boot forever');
});

test('the migration is registered — an unregistered file never runs', async () => {
    const core = require('fs').readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.ok(core.includes('automation-run-root-2026-08'), 'listed in MIGRATIONS');
});
