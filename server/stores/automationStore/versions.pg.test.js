/**
 * Versions against a real Postgres (@electric-sql/pglite, in-process), handoff 5:
 *
 *   - a layout-only save updates the working copy but writes NO version, and
 *     the next structural save's version carries the positions;
 *   - every version row gets its plain-language description (text + codes);
 *   - a forced (restore) write of positions only is a version marked
 *     layout-only, which is no pending change;
 *   - runs per version and the header counts count journeys, leave test runs
 *     out, and narrow to the caller's own runs for a run-only share;
 *   - a milestone name is set and cleared; a version reads by number;
 *   - organisation templates stay inside their organisation.
 *
 * The store functions are built over the PGlite handle (updateAutomationWith,
 * makeVersionQueries, makeTemplateStore): no module mocking.
 *
 * Run: cd server && node --test stores/automationStore/versions.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();

const { up } = require('../../migrations/automation-handoff5-2026-09');
const { updateAutomationWith } = require('./automations');
const { makeVersionQueries } = require('./versions');
const { makeTemplateStore } = require('./templates');
const { makeLifecycleStore } = require('./lifecycle');

const versions = makeVersionQueries(db);
const templates = makeTemplateStore(db);
const lifecycle = makeLifecycleStore(db);

const DEF = {
    trigger: { id: 't', type: 'trigger', kind: 'manual', position: { x: 0, y: 0 } },
    steps: [{ id: 'a', type: 'code', code: '1', label: 'Calc', position: { x: 300, y: 0 } }],
    edges: [{ from: 't', to: 'a' }],
};
const clone = (x) => JSON.parse(JSON.stringify(x));

async function seed(id, { def = DEF, version = 1, live = null } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, title, definition_json, version, is_draft, is_active, live_version, live_definition_json, live_at)
         VALUES ($1, 'u1', $1, $2, $3, $4, $5, $6, $7, CASE WHEN $6::int IS NULL THEN NULL ELSE NOW() END)`,
        [id, JSON.stringify(def), version, live == null, live != null, live, live == null ? null : JSON.stringify(def)],
    );
    await pg.query(
        `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, change_summary)
         VALUES ($1, $2, $3, $4, 'u1', 'Created')`,
        [`${id}-v${version}`, id, version, JSON.stringify(def)],
    );
}
async function versionRows(id) {
    return (await pg.query('SELECT version, definition_json, description, description_json, is_layout_only FROM automation_versions WHERE automation_id = $1 ORDER BY version', [id])).rows;
}
async function row(id) {
    return (await pg.query('SELECT version, definition_json FROM automations WHERE id = $1', [id])).rows[0];
}

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, "displayName" TEXT);
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            kind TEXT NOT NULL DEFAULT 'automation',
            title TEXT NOT NULL,
            description TEXT,
            icon TEXT,
            category TEXT,
            definition_json JSONB NOT NULL,
            builder_session JSONB,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT,
            schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at TIMESTAMPTZ,
            last_run_at TIMESTAMPTZ,
            last_status TEXT,
            run_timeout_ms INTEGER,
            project_id TEXT,
            folder_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_versions (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            definition_json JSONB NOT NULL,
            saved_by_user_id TEXT NOT NULL,
            saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            change_summary TEXT,
            UNIQUE (automation_id, version)
        );
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY,
            automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            trigger_kind TEXT NOT NULL,
            mode TEXT NOT NULL DEFAULT 'live',
            status TEXT NOT NULL DEFAULT 'queued',
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            root_run_id TEXT,
            submitted_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
            step_id TEXT NOT NULL,
            step_type TEXT NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (run_id, step_id, attempts)
        );
    `);
    await up({ exec: (sql) => pg.exec(sql) });
});

after(async () => { await pg.close(); });

test('a layout-only save writes the working copy but no version; the next real save carries the positions', async () => {
    await seed('lay');
    const dragged = clone(DEF);
    dragged.steps[0].position = { x: 640, y: 120 };
    const a = await updateAutomationWith(db, 'lay', { definition: dragged }, 'u1');
    assert.strictEqual(a.version, 1, 'no version bump');
    assert.deepStrictEqual((await row('lay')).definition_json.steps[0].position, { x: 640, y: 120 });
    assert.strictEqual((await versionRows('lay')).length, 1, 'no version row');

    const changed = clone(dragged);
    changed.steps[0].code = '2';
    const b = await updateAutomationWith(db, 'lay', { definition: changed }, 'u1');
    assert.strictEqual(b.version, 2);
    const rows = await versionRows('lay');
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows[1].definition_json.steps[0].position, { x: 640, y: 120 }, 'the positions ride along');
    assert.strictEqual(rows[1].description, 'Code changed in "Calc"');
    assert.deepStrictEqual(rows[1].description_json, [{ code: 'setting_changed', params: { setting: 'Code', settingKey: 'code', step: 'Calc' } }]);
    assert.strictEqual(rows[1].is_layout_only, false);
});

test('a forced restore of positions only is a layout-only version, never a pending change', async () => {
    await seed('rst', { live: 1 });
    const back = clone(DEF);
    back.steps[0].position = { x: 5, y: 5 };
    const a = await updateAutomationWith(db, 'rst', { definition: back }, 'u1', {
        forceVersion: true,
        versionMeta: { description: 'Restored from v1', descriptionJson: [{ code: 'restored', params: { version: 1 } }] },
    });
    assert.strictEqual(a.version, 2);
    const rows = await versionRows('rst');
    assert.strictEqual(rows[1].is_layout_only, true);
    assert.strictEqual(rows[1].description, 'Restored from v1');
    assert.strictEqual(a.pendingChanges, 0);
    assert.strictEqual(await lifecycle.countPendingChanges('rst'), 0);
});

test('a structural save on a live routine is one pending change; the live copy stays', async () => {
    await seed('liv', { live: 1 });
    const next = clone(DEF);
    next.steps.push({ id: 'b', type: 'code', code: 'x', label: 'More' });
    next.edges.push({ from: 'a', to: 'b' });
    const a = await updateAutomationWith(db, 'liv', { definition: next }, 'u1');
    assert.strictEqual(a.version, 2);
    assert.strictEqual(a.liveVersion, 1);
    assert.strictEqual(a.pendingChanges, 1);
    const rows = await versionRows('liv');
    assert.deepStrictEqual(rows[1].description_json, [{ code: 'step_added', params: { step: 'More' } }]);
});

test('a settings-only save on a live routine is a "Settings changed" version, never a pending change', async () => {
    await seed('set', { live: 1 });
    const next = clone(DEF);
    next.runPolicy = { retry: { max: 2 } };
    next.notificationSettings = { onFailure: { enabled: true } };
    next.steps[0].position = { x: 40, y: 40 };
    const a = await updateAutomationWith(db, 'set', { definition: next }, 'u1');
    assert.strictEqual(a.version, 2, 'a version is written, so the history shows it');
    assert.strictEqual(a.liveVersion, 1, 'the live copy stays');
    assert.strictEqual(a.pendingChanges, 0);
    assert.strictEqual(await lifecycle.countPendingChanges('set'), 0);
    const rows = await versionRows('set');
    assert.strictEqual(rows[1].is_layout_only, true);
    assert.strictEqual(rows[1].description, 'Settings changed');
    assert.deepStrictEqual(rows[1].description_json, [{ code: 'settings_changed', params: {} }]);
});

test('a non-definition write never touches versions', async () => {
    await seed('ttl');
    const a = await updateAutomationWith(db, 'ttl', { title: 'Renamed', icon: 'bell' }, 'u1');
    assert.strictEqual(a.version, 1);
    assert.strictEqual(a.title, 'Renamed');
    assert.strictEqual((await versionRows('ttl')).length, 1);
});

test('runs per version and the header counts: journeys, no test runs, own runs for run-only', async () => {
    await seed('cnt', { version: 2 });
    const add = (id, version, status, extra = {}) => pg.query(
        `INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, mode, status, started_at, root_run_id, is_test, started_by_user_id, submitted_by_user_id)
         VALUES ($1, 'cnt', $2, 'u1', 'manual', $3, $4, $5, $6, $7, $8, $9)`,
        [id, version, extra.mode || 'live', status, extra.startedAt || new Date().toISOString(), extra.root || null,
            !!extra.isTest, extra.by || null, extra.submitted || null],
    );
    await add('r1', 1, 'success', { startedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });
    await add('r2', 2, 'error', { by: 'ron' });
    await add('r3', 2, 'awaiting_form', { by: 'u1' });
    // r3's journey continues in r3b, which fails: the journey counts once, as failed.
    await add('r3b', 2, 'error', { root: 'r3', startedAt: new Date(Date.now() + 1000).toISOString() });
    await add('r4', 2, 'success', { isTest: true });
    await add('r5', 2, 'success', { mode: 'dry_run' });

    const per = await versions.countRunsByVersion('cnt');
    assert.deepStrictEqual(per.get(1), { total: 1, failed: 0 });
    assert.deepStrictEqual(per.get(2), { total: 2, failed: 2 });

    const counts = await versions.countsForAutomation('cnt');
    assert.deepStrictEqual(counts, { runs7d: 2, runsFailed7d: 2, versions: 1 });
    const mine = await versions.countsForAutomation('cnt', { onlyUserId: 'ron' });
    assert.deepStrictEqual(mine, { runs7d: 1, runsFailed7d: 1, versions: 1 });
});

test('a milestone name is set and cleared; a version reads by number', async () => {
    await seed('nam');
    assert.deepStrictEqual(await versions.renameVersion('nam', 1, 'Go-live'), { id: 'nam-v1', version: 1, name: 'Go-live' });
    const v = await versions.getVersionByNumber('nam', 1);
    assert.strictEqual(v.name, 'Go-live');
    assert.strictEqual(v.definition.steps[0].id, 'a');
    assert.deepStrictEqual(await versions.renameVersion('nam', 1, null), { id: 'nam-v1', version: 1, name: null });
    assert.strictEqual(await versions.renameVersion('nam', 7, 'x'), null);
    assert.strictEqual(await versions.getVersionByNumber('nam', 7), null);
    assert.strictEqual(await versions.getVersionByNumber('nam', 'abc'), null);
});

test('organisation templates stay inside their organisation; org-less ones with their saver', async () => {
    const t = await templates.createTemplate({ organizationId: 'org1', createdBy: 'u1', title: 'Invoices', description: 'Reads them', icon: 'file', definition: DEF });
    assert.match(t.id, /^org-/);
    await templates.createTemplate({ organizationId: null, createdBy: 'solo', title: 'Mine', definition: DEF });
    assert.deepStrictEqual((await templates.listTemplatesFor({ userId: 'u9', orgId: 'org1' })).map((x) => x.title), ['Invoices']);
    assert.deepStrictEqual((await templates.listTemplatesFor({ userId: 'u9', orgId: 'org2' })), []);
    assert.deepStrictEqual((await templates.listTemplatesFor({ userId: 'solo' })).map((x) => x.title), ['Mine']);
    assert.strictEqual((await templates.getTemplateFor(t.id, { userId: 'u9', orgId: 'org1' })).definition.steps[0].id, 'a');
    assert.strictEqual(await templates.getTemplateFor(t.id, { userId: 'u9', orgId: 'org2' }), null);
    assert.strictEqual(await templates.getTemplateFor(t.id, { userId: 'u1' }), null, 'no org scope, not the org-less saver list');
});
