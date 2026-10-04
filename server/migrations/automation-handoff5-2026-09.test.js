/**
 * automation-handoff5-2026-09 against a real Postgres (@electric-sql/pglite,
 * in-process; `exec` injected — no module mocking).
 *
 * Proven:
 *   - the backfill gives every routine that has been live (is_draft = FALSE)
 *     its current definition as live version, and leaves drafts and
 *     Reusable Steps alone;
 *   - the backfill runs ONCE: migrations replay on every boot, and a second
 *     run must not publish the working copy a routine has moved on to since;
 *   - every column and table the handoff-5 packages build on exists, with the
 *     defaults and constraints they rely on;
 *   - it is registered, so it actually runs.
 *
 * Run: cd server && node --test migrations/automation-handoff5-2026-09.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { PGlite } = require('@electric-sql/pglite');

const pg = new PGlite();
const exec = (sql) => pg.exec(sql);
const q = async (sql, params) => (await pg.query(sql, params)).rows;

const { up } = require('./automation-handoff5-2026-09');

// The tables as the earlier migrations leave them, trimmed to what this one touches.
const BASE_SCHEMA = `
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'automation',
            title TEXT NOT NULL,
            definition_json JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE
        );
        CREATE TABLE automation_versions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json JSONB NOT NULL,
            saved_by_user_id TEXT NOT NULL,
            UNIQUE (automation_id, version)
        );
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'queued'
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            step_type TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (run_id, step_id, attempts)
        );
`;


before(async () => {
    await pg.exec(`${BASE_SCHEMA}
        INSERT INTO automations (id, user_id, kind, title, definition_json, version, is_active, is_draft) VALUES
            ('active',  'u1', 'automation', 'Active',  '{"trigger":{"kind":"manual"},"steps":[{"id":"s1"}]}', 4, TRUE,  FALSE),
            ('paused',  'u1', 'automation', 'Paused',  '{"trigger":{"kind":"manual"},"steps":[]}',            2, FALSE, FALSE),
            ('draft',   'u1', 'automation', 'Draft',   '{"trigger":{"kind":"manual"},"steps":[]}',            3, FALSE, TRUE),
            ('block',   'u1', 'block',      'A Step',  '{"trigger":{"kind":"manual"},"steps":[]}',            5, FALSE, FALSE);
    `);
    await up({ exec });
});

after(async () => { await pg.close(); });

test('routines that have been live get their current definition as the live version', async () => {
    const [row] = await q('SELECT live_version, live_definition_json, live_at FROM automations WHERE id = $1', ['active']);
    assert.strictEqual(row.live_version, 4);
    assert.deepStrictEqual(row.live_definition_json, { trigger: { kind: 'manual' }, steps: [{ id: 's1' }] });
    assert.ok(row.live_at, 'live_at is stamped');
    // Paused but once activated (is_draft FALSE) counts as having been live.
    const [paused] = await q('SELECT live_version FROM automations WHERE id = $1', ['paused']);
    assert.strictEqual(paused.live_version, 2);
});

test('drafts and Reusable Steps are left without a live version', async () => {
    const rows = await q("SELECT id, live_version, live_definition_json FROM automations WHERE id IN ('draft', 'block') ORDER BY id");
    for (const r of rows) {
        assert.strictEqual(r.live_version, null, `${r.id} must stay live-less`);
        assert.strictEqual(r.live_definition_json, null);
    }
});

test('a second boot does not re-run the backfill (pending changes stay pending)', async () => {
    // The owner saves twice after the migration: the working copy moves on.
    await pg.query(`UPDATE automations SET version = 6, definition_json = '{"trigger":{"kind":"manual"},"steps":[]}' WHERE id = 'active'`);
    await up({ exec });
    const [row] = await q('SELECT version, live_version, live_definition_json FROM automations WHERE id = $1', ['active']);
    assert.strictEqual(row.version, 6);
    assert.strictEqual(row.live_version, 4, 'the live version must not follow the working copy on a re-run');
    assert.deepStrictEqual(row.live_definition_json.steps, [{ id: 's1' }]);
});

test('the columns the other packages build on exist, with their defaults', async () => {
    const cols = await q(`SELECT table_name, column_name, is_nullable, column_default FROM information_schema.columns
                           WHERE table_name IN ('automations', 'automation_versions', 'automation_runs', 'automation_run_steps')`);
    const has = (t, c) => cols.find(x => x.table_name === t && x.column_name === c);
    for (const [t, c] of [
        ['automations', 'live_version'], ['automations', 'live_definition_json'], ['automations', 'live_at'],
        ['automations', 'deleted_at'], ['automations', 'deleted_by'],
        ['automation_versions', 'name'], ['automation_versions', 'description'], ['automation_versions', 'description_json'],
        ['automation_versions', 'is_layout_only'],
        ['automation_runs', 'started_by_user_id'], ['automation_runs', 'outcome_json'], ['automation_runs', 'caller_agent_id'],
        ['automation_runs', 'caller_conversation_id'], ['automation_runs', 'is_test'],
        ['automation_run_steps', 'tools_withheld'], ['automation_run_steps', 'error_info'],
    ]) assert.ok(has(t, c), `${t}.${c} is missing`);
    assert.strictEqual(has('automation_versions', 'is_layout_only').is_nullable, 'NO');
    assert.match(String(has('automation_versions', 'is_layout_only').column_default), /false/i);
    assert.strictEqual(has('automation_runs', 'is_test').is_nullable, 'NO');
});

test('shares: roles and principal types are constrained, one row per principal', async () => {
    await pg.query(`INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role) VALUES ('s1', 'active', 'user', 'u2', 'run')`);
    await assert.rejects(pg.query(`INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role) VALUES ('s2', 'active', 'user', 'u2', 'edit')`),
        'a principal is on a routine once');
    await assert.rejects(pg.query(`INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role) VALUES ('s3', 'active', 'team', 'x', 'run')`));
    await assert.rejects(pg.query(`INSERT INTO automation_shares (id, automation_id, principal_type, principal_id, role) VALUES ('s4', 'active', 'group', 'g', 'admin')`));
});

test('notification events and templates exist with their defaults', async () => {
    await pg.query(`INSERT INTO automation_notification_events (id, automation_id, event, recipient_user_id, channel) VALUES ('n1', 'active', 'onError', 'u1', 'bell')`);
    const [n] = await q(`SELECT urgency, bundled, delivered_at, created_at FROM automation_notification_events WHERE id = 'n1'`);
    assert.strictEqual(n.urgency, 'normal');
    assert.strictEqual(n.bundled, false);
    assert.strictEqual(n.delivered_at, null);
    assert.ok(n.created_at);
    await pg.query(`INSERT INTO automation_templates (id, organization_id, created_by, title, definition_json) VALUES ('t1', 'org', 'u1', 'Invoices', '{}')`);
    const [t] = await q(`SELECT title, created_at FROM automation_templates WHERE id = 't1'`);
    assert.strictEqual(t.title, 'Invoices');
});

test('child rows cascade with the routine (shares, notification events)', async () => {
    await pg.query(`DELETE FROM automations WHERE id = 'active'`);
    const [s] = await q(`SELECT COUNT(*)::int AS n FROM automation_shares WHERE automation_id = 'active'`);
    const [n] = await q(`SELECT COUNT(*)::int AS n FROM automation_notification_events WHERE automation_id = 'active'`);
    assert.strictEqual(s.n, 0);
    assert.strictEqual(n.n, 0);
});

// automation-extras-2026-06 used to create a §26 gallery table under the same name.
const LEGACY_TEMPLATES = `
    CREATE TABLE automation_templates (
        id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL, category TEXT,
        definition JSONB NOT NULL, org_id TEXT, source TEXT NOT NULL DEFAULT 'official'
    );
    CREATE INDEX idx_automation_templates_category ON automation_templates(category) WHERE category IS NOT NULL;
    CREATE INDEX idx_automation_templates_source ON automation_templates(source);
    CREATE INDEX idx_automation_templates_org ON automation_templates(org_id) WHERE org_id IS NOT NULL;
`;

async function withLegacyTemplates(rows) {
    const db = new PGlite();
    await db.exec(`${BASE_SCHEMA}\n${LEGACY_TEMPLATES}\n${rows}`);
    await up({ exec: (sql) => db.exec(sql) });
    await up({ exec: (sql) => db.exec(sql) }); // every boot replays it
    return db;
}

const columnsOf = async (db, table) => (await db.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table])).rows.map(r => r.column_name);

test('an empty legacy automation_templates is replaced by the org templates table', async () => {
    const db = await withLegacyTemplates('');
    const cols = await columnsOf(db, 'automation_templates');
    assert.ok(cols.includes('organization_id') && cols.includes('definition_json'));
    assert.ok(!cols.includes('slug'));
    assert.deepStrictEqual(await columnsOf(db, 'automation_templates_legacy_2026_06'), []);
    await db.query(`INSERT INTO automation_templates (id, organization_id, created_by, title, definition_json) VALUES ('t1', 'org', 'u1', 'Invoices', '{}')`);
    await db.close();
});

test('a legacy automation_templates with rows is renamed, not dropped', async () => {
    const db = await withLegacyTemplates(`INSERT INTO automation_templates (id, slug, title, definition) VALUES ('g1', 'g1', 'Old', '{}');`);
    const [old] = (await db.query(`SELECT title FROM automation_templates_legacy_2026_06 WHERE id = 'g1'`)).rows;
    assert.strictEqual(old.title, 'Old');
    assert.ok((await columnsOf(db, 'automation_templates')).includes('organization_id'));
    await db.close();
});

test('it is registered in the automationStore migration list', () => {
    const { MIGRATIONS } = require('../stores/automationStore/core');
    // Later migrations are appended after it; only its presence (once) matters.
    assert.strictEqual(MIGRATIONS.filter(m => m === 'automation-handoff5-2026-09').length, 1);
});
