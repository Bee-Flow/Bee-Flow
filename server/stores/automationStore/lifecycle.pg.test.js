/**
 * The live/working split and the trash, against a real Postgres
 * (@electric-sql/pglite, in-process). The store is built with
 * makeLifecycleStore over the PGlite handle: no module mocking.
 *
 * Proven:
 *   - pendingChanges counts structural versions after the live one and
 *     ignores layout-only saves; 0 while never live;
 *   - publish copies EXACTLY the checked version (a save in between → null),
 *     moves the trigger columns with it, and clears the pending count;
 *   - a working-copy save leaves the live copy alone (LIVE_INVARIANT_SQL with
 *     goLive false), a never-live automation switched on publishes, and a
 *     goLive write moves live along;
 *   - on a live automation a plain save may not move the trigger columns
 *     (stripLiveFollowingFields);
 *   - trash: soft delete switches off and hides the row, keeps its runs;
 *     restore brings it back paused; purge removes only trashed rows;
 *   - per-automation run retention deletes only runs past the automation's window.
 *
 * Run: cd server && node --test stores/automationStore/lifecycle.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();

const { up } = require('../../migrations/automation-handoff5-2026-09');
const {
    makeLifecycleStore, LIVE_INVARIANT_SQL, stripLiveFollowingFields, TRASH_RETENTION_DAYS,
} = require('./lifecycle');

const store = makeLifecycleStore(db);

const DEF = (n) => JSON.stringify({ trigger: { kind: 'manual', id: 't' }, steps: Array.from({ length: n }, (_, i) => ({ id: `s${i}` })) });

async function seed(id, { version = 1, live = null, active = false, draft = true, kind = 'automation', steps = 1 } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, kind, title, definition_json, version, is_active, is_draft, live_version, live_definition_json, live_at)
         VALUES ($1, 'u1', $2, $1, $3, $4, $5, $6, $7, $8, CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() END)`,
        [id, kind, DEF(steps), version, active, draft, live, live == null ? null : DEF(1)],
    );
}
async function addVersion(id, version, { layoutOnly = false } = {}) {
    await pg.query(
        `INSERT INTO automation_versions (id, automation_id, version, definition_json, saved_by_user_id, is_layout_only)
         VALUES ($1, $2, $3, '{}', 'u1', $4)`,
        [`${id}-v${version}`, id, version, layoutOnly],
    );
}

before(async () => {
    await pg.exec(`
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
            project_id TEXT,
            kind TEXT NOT NULL DEFAULT 'automation',
            title TEXT NOT NULL,
            description TEXT,
            definition_json JSONB NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE,
            is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE,
            trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT,
            schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam',
            next_run_at TIMESTAMPTZ,
            run_timeout_ms INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
            status TEXT NOT NULL DEFAULT 'queued',
            finished_at TIMESTAMPTZ,
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

test('pendingChanges: structural versions after the live one; layout-only saves do not count', async () => {
    await seed('p1', { version: 5, live: 2, active: true, draft: false });
    for (const v of [1, 2, 3, 5]) await addVersion('p1', v);
    await addVersion('p1', 4, { layoutOnly: true });
    assert.strictEqual(await store.countPendingChanges('p1'), 2);   // v3 and v5
    const a = await store.selectOne('p1');
    assert.strictEqual(a.pendingChanges, 2);
    assert.strictEqual(a.liveVersion, 2);
    assert.strictEqual(a.neverLive, false);
    // The live copy is on the object for the runner, but never serialised.
    assert.ok(a.liveDefinition && Array.isArray(a.liveDefinition.steps));
    assert.ok(!('liveDefinition' in JSON.parse(JSON.stringify(a))));
});

test('pendingChanges is 0 while never live', async () => {
    await seed('p2', { version: 3 });
    for (const v of [1, 2, 3]) await addVersion('p2', v);
    const a = await store.selectOne('p2');
    assert.strictEqual(a.pendingChanges, 0);
    assert.strictEqual(a.neverLive, true);
    assert.strictEqual(a.liveVersion, null);
});

test('publish copies exactly the checked version, with its trigger columns', async () => {
    await seed('pub', { version: 4, live: 2, active: true, draft: false, steps: 3 });
    for (const v of [2, 3, 4]) await addVersion('pub', v);
    // Someone saved v5 after the person reviewed v4 — nothing goes live.
    assert.strictEqual(await store.publishWorkingCopy('pub', { expectedVersion: 3 }), null);
    const [still] = (await db.query('SELECT live_version FROM automations WHERE id = $1', ['pub'])).rows;
    assert.strictEqual(still.live_version, 2);

    const next = new Date(Date.now() + 3600_000).toISOString();
    const a = await store.publishWorkingCopy('pub', {
        expectedVersion: 4,
        columns: { triggerType: 'schedule', scheduleCron: '0 7 * * 1-5', scheduleTz: 'Europe/Amsterdam', nextRunAt: next, runTimeoutMs: 1_800_000, isDraft: false },
    });
    assert.strictEqual(a.liveVersion, 4);
    assert.strictEqual(a.pendingChanges, 0);
    assert.strictEqual(a.liveDefinition.steps.length, 3, 'the working copy is what went live');
    assert.strictEqual(a.triggerType, 'schedule');
    assert.strictEqual(a.scheduleCron, '0 7 * * 1-5');
    assert.strictEqual(a.runTimeoutMs, 1_800_000);
    assert.ok(a.liveAt);
});

test('a working-copy save on a live automation leaves the live copy alone', async () => {
    await seed('w1', { version: 2, live: 2, active: true, draft: false, steps: 1 });
    // What updateAutomation does for a definition write: new working copy,
    // version + 1, then the invariant statement with goLive = false.
    await pg.query(`UPDATE automations SET definition_json = $2, version = version + 1 WHERE id = $1`, ['w1', DEF(4)]);
    await pg.query(LIVE_INVARIANT_SQL, ['w1', false]);
    const [row] = (await db.query('SELECT version, live_version, live_definition_json FROM automations WHERE id = $1', ['w1'])).rows;
    assert.strictEqual(row.version, 3);
    assert.strictEqual(row.live_version, 2);
    assert.strictEqual(row.live_definition_json.steps.length, 1);
});

test('a goLive write moves the live copy along', async () => {
    await pg.query(`UPDATE automations SET definition_json = $2, version = version + 1 WHERE id = $1`, ['w1', DEF(5)]);
    await pg.query(LIVE_INVARIANT_SQL, ['w1', true]);
    const [row] = (await db.query('SELECT version, live_version, live_definition_json FROM automations WHERE id = $1', ['w1'])).rows;
    assert.strictEqual(row.live_version, row.version);
    assert.strictEqual(row.live_definition_json.steps.length, 5);
});

test('a goLive write on a never-live draft publishes nothing; switching it on does', async () => {
    await seed('d1', { version: 1 });
    await pg.query(LIVE_INVARIANT_SQL, ['d1', true]);
    let [row] = (await db.query('SELECT live_version FROM automations WHERE id = $1', ['d1'])).rows;
    assert.strictEqual(row.live_version, null);
    await pg.query(`UPDATE automations SET is_active = TRUE, is_draft = FALSE WHERE id = $1`, ['d1']);
    await pg.query(LIVE_INVARIANT_SQL, ['d1', false]);
    [row] = (await db.query('SELECT live_version FROM automations WHERE id = $1', ['d1'])).rows;
    assert.strictEqual(row.live_version, 1, 'an active automation always has a live version');
});

test('the invariant never touches a Reusable Step', async () => {
    await seed('blk', { kind: 'block', active: true, draft: false });
    await pg.query(LIVE_INVARIANT_SQL, ['blk', true]);
    const [row] = (await db.query('SELECT live_version FROM automations WHERE id = $1', ['blk'])).rows;
    assert.strictEqual(row.live_version, null);
});

test('on a live automation a plain save may not move the trigger columns', () => {
    const updates = { definition: '{}', triggerType: 'schedule', scheduleCron: '* * * * *', scheduleTz: 'UTC', nextRunAt: 'x', title: 'T' };
    assert.deepStrictEqual(stripLiveFollowingFields(updates, { hasLive: true }), { definition: '{}', nextRunAt: 'x', title: 'T' });
    assert.deepStrictEqual(stripLiveFollowingFields(updates, { hasLive: true, goLive: true }), updates);
    assert.deepStrictEqual(stripLiveFollowingFields(updates, { hasLive: false }), updates);
});

test('trash: switched off, hidden from reads, runs kept; restore comes back paused', async () => {
    await seed('t1', { version: 1, live: 1, active: true, draft: false });
    await pg.query(`INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, status) VALUES ('r1', 't1', 1, 'u1', 'manual', 'success')`);
    const trashed = await store.trashAutomation('t1', 'u1');
    assert.ok(trashed.deletedAt);
    assert.strictEqual(trashed.deletedBy, 'u1');
    assert.strictEqual(trashed.isActive, false);
    assert.strictEqual(await store.selectOne('t1'), null, 'reads exclude trashed rows');
    assert.ok(await store.selectOne('t1', { includeDeleted: true }));
    assert.strictEqual(await store.trashAutomation('t1', 'u1'), null, 'twice is a miss');
    const [runs] = (await db.query(`SELECT COUNT(*)::int AS n FROM automation_runs WHERE automation_id = 't1'`)).rows;
    assert.strictEqual(runs.n, 1, 'runs are kept while in the trash');

    const list = await store.listTrash('u1');
    const hit = list.find(a => a.id === 't1');
    assert.ok(hit);
    assert.strictEqual(new Date(hit.purgeAt).getTime() - new Date(hit.deletedAt).getTime(), TRASH_RETENTION_DAYS * 86_400_000);
    assert.strictEqual((await store.listTrash('someone-else')).length, 0);

    const restored = await store.restoreAutomation('t1');
    assert.strictEqual(restored.deletedAt, null);
    assert.strictEqual(restored.isActive, false, 'restored paused');
    assert.strictEqual(restored.liveVersion, 1, 'the live version survives the trash');
    assert.strictEqual(await store.restoreAutomation('t1'), null, 'not in the trash any more');
});

test('purge: only trashed rows past the window, and only while still trashed', async () => {
    await seed('old', {});
    await seed('fresh', {});
    await store.trashAutomation('old', 'u1');
    await store.trashAutomation('fresh', 'u1');
    await pg.query(`UPDATE automations SET deleted_at = NOW() - INTERVAL '31 days' WHERE id = 'old'`);
    const due = await store.listPurgeableTrash();
    assert.deepStrictEqual(due.map(r => r.id), ['old']);
    assert.strictEqual(await store.purgeTrashedAutomation('p1'), false, 'a live row is never purged');
    assert.strictEqual(await store.purgeTrashedAutomation('old'), true);
    const [left] = (await db.query(`SELECT COUNT(*)::int AS n FROM automations WHERE id = 'old'`)).rows;
    assert.strictEqual(left.n, 0);
});

test('per-automation run retention: only terminal runs past the automation window', async () => {
    await pg.query(`INSERT INTO automations (id, user_id, title, definition_json, version, live_version, live_definition_json)
                    VALUES ('ret', 'u1', 'ret', '{"runPolicy":{"retentionDays":7}}', 2, 1, '{"runPolicy":{"retentionDays":30}}')`);
    await pg.query(`INSERT INTO automations (id, user_id, title, definition_json) VALUES ('noret', 'u1', 'noret', '{}')`);
    await pg.query(`INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, status, finished_at) VALUES
        ('old-ok',   'ret',   1, 'u1', 'manual', 'success', NOW() - INTERVAL '10 days'),
        ('old-wait', 'ret',   1, 'u1', 'manual', 'awaiting_approval', NOW() - INTERVAL '10 days'),
        ('new-ok',   'ret',   1, 'u1', 'manual', 'error',   NOW() - INTERVAL '2 days'),
        ('other',    'noret', 1, 'u1', 'manual', 'success', NOW() - INTERVAL '10 days')`);
    // runPolicy is a setting (applies without a publish): the WORKING copy's
    // 7 days apply, not the live copy's 30.
    const n = await store.deleteRunsPastAutomationRetention({ platformDays: 90 });
    assert.strictEqual(n, 1);
    const ids = (await db.query(`SELECT id FROM automation_runs WHERE automation_id IN ('ret', 'noret') ORDER BY id`)).rows.map(r => r.id);
    assert.deepStrictEqual(ids, ['new-ok', 'old-wait', 'other']);
    // An automation window at or above the platform one is the platform's business.
    await pg.query(`INSERT INTO automation_runs (id, automation_id, version, user_id, trigger_kind, status, finished_at) VALUES
        ('old-ok2', 'ret', 1, 'u1', 'manual', 'success', NOW() - INTERVAL '10 days')`);
    assert.strictEqual(await store.deleteRunsPastAutomationRetention({ platformDays: 5 }), 0);
});
