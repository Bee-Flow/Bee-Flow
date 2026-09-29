/**
 * The root_run_id migration: an idempotent ADD COLUMN, two indexes, and a
 * one-shot backfill that reconstructs journeys from history.
 *
 * Three things are pinned here because the automation store replays every
 * migration on every boot:
 *   (a) the DDL stays IF NOT EXISTS — a non-idempotent ALTER would fail every
 *       boot after the first, and core.js only LOGS migration failures;
 *   (b) the backfill runs only when something still lacks a root, so a normal
 *       boot does not build a recursive CTE over the whole runs table;
 *   (c) the journey index is on the COALESCE EXPRESSION, not on the bare
 *       column. Every journey query asks for COALESCE(root_run_id, id) so that
 *       rows predating the column keep matching themselves, and a plain b-tree
 *       on root_run_id cannot answer that.
 *
 * The pg layer is mocked via require.cache (mirrors
 * automation-pii-summary-2026-08.test.js).
 *
 * Run: node --test migrations/automation-run-root-2026-08.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ddl = [];
const statements = [];
let hasUnrooted = true;
const flat = (sql) => String(sql).replace(/\s+/g, ' ').trim();
const fakeDb = {
    async exec(sql) { ddl.push(flat(sql)); },
    async run(sql) { statements.push(flat(sql)); return { rowCount: 0, rows: [] }; },
    async getOne() { return hasUnrooted ? { x: 1 } : null; },
};

const dbPath = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const migration = require('./automation-run-root-2026-08');

const reset = () => { ddl.length = 0; statements.length = 0; };

test('adds the nullable column, idempotently', async () => {
    reset();
    await migration.up();
    await migration.up();
    const adds = ddl.filter(s => s.startsWith('ALTER TABLE'));
    assert.equal(adds.length, 2, 'ran twice');
    for (const s of adds) {
        assert.match(s, /ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS root_run_id TEXT/);
    }
});

test('indexes the COALESCE expression the journey queries actually use', async () => {
    reset();
    await migration.up();
    const idx = ddl.filter(s => s.includes('CREATE INDEX'));
    assert.ok(idx.every(s => s.includes('IF NOT EXISTS')), 'replayed on every boot');
    const journey = idx.find(s => s.includes('idx_automation_runs_journey'));
    assert.ok(journey, 'the leaf lookup has an index');
    assert.match(journey, /\(\(COALESCE\(root_run_id, id\)\), started_at DESC, id DESC\)/);
    const heads = idx.find(s => s.includes('idx_automation_runs_user_heads'));
    assert.ok(heads, 'the list has one too');
    assert.match(heads, /WHERE root_run_id IS NULL OR root_run_id = id/);
});

test('the backfill is skipped once every run has a root', async () => {
    reset();
    hasUnrooted = false;
    await migration.up();
    hasUnrooted = true;
    assert.equal(statements.length, 0, 'no CTE, no table-wide UPDATE, on an ordinary boot');
});

test('the backfill only follows a link the parent NAMES or shares a trigger with', async () => {
    // parent_run_id is set by retries and by partial "▶ Execute from here" runs
    // as well as by continuations, and only the summary marker distinguishes
    // them in history. Matching the phrase alone would let a partial run —
    // parented onto whatever ran last — be swallowed into a stranger's journey.
    reset();
    await migration.up();
    const cte = statements.find(s => s.includes('WITH RECURSIVE'));
    assert.ok(cte, 'the walk runs when there is something to backfill');
    assert.match(cte, /Resumed %see child run ' \|\| r\.id/, 'the base branch tests the row itself');
    assert.match(cte, /Resumed %see child run ' \|\| c\.id/, 'the recursive branch tests the child');
    assert.match(cte, /trigger_kind = p\.trigger_kind/, 'a sibling of a named child still counts');
});

test('anything the walk missed roots itself, so the probe goes quiet', async () => {
    reset();
    await migration.up();
    const net = statements.find(s => /UPDATE automation_runs SET root_run_id = id WHERE root_run_id IS NULL/.test(s));
    assert.ok(net, 'without this the walk would re-run on every boot forever');
});

test('the migration is registered — an unregistered file never runs', async () => {
    const core = require('fs').readFileSync(path.join(__dirname, '..', 'stores', 'automationStore', 'core.js'), 'utf8');
    assert.ok(core.includes('automation-run-root-2026-08'), 'listed in MIGRATIONS');
});
