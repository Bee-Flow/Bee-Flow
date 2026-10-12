/**
 * automation_notification_events against a real Postgres (@electric-sql/pglite,
 * in-process), built with makeNotificationEventsStore: no module mocking.
 *
 * Proven:
 *   - the throttle counts messages (not channel rows) in the window, and never
 *     counts held rows;
 *   - pending bundles group per automation, event and recipient, skip rows held
 *     for the digest, and disappear once reported;
 *   - the digest reads: which automations have it on, the last summary per
 *     recipient and automation, run statistics (live, not tests, heads only,
 *     waiting counted whenever it started), held rows;
 *   - recent attempts and the retention purge.
 *
 * Run: cd server && node --test stores/automationStore/notificationEvents.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();

const { up } = require('../../migrations/automation-handoff5-2026-09');
const { makeNotificationEventsStore } = require('./notificationEvents');

const store = makeNotificationEventsStore(db);
const T0 = new Date('2026-09-28T10:00:00Z');
const at = (min) => new Date(T0.getTime() + min * 60_000);

before(async () => {
    await pg.exec(`
        CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT, "displayName" TEXT, "organizationId" TEXT, groups TEXT DEFAULT '[]', status TEXT DEFAULT 'active');
        CREATE TABLE automations (
            id TEXT PRIMARY KEY, user_id TEXT NOT NULL, organization_id TEXT,
            kind TEXT NOT NULL DEFAULT 'automation', title TEXT NOT NULL, description TEXT,
            definition_json JSONB NOT NULL, version INTEGER NOT NULL DEFAULT 1,
            is_active BOOLEAN NOT NULL DEFAULT FALSE, is_draft BOOLEAN NOT NULL DEFAULT TRUE,
            needs_first_run_confirm BOOLEAN NOT NULL DEFAULT TRUE, trigger_type TEXT NOT NULL DEFAULT 'manual',
            schedule_cron TEXT, schedule_tz TEXT NOT NULL DEFAULT 'Europe/Amsterdam', next_run_at TIMESTAMPTZ,
            run_timeout_ms INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_versions (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL, definition_json JSONB NOT NULL, saved_by_user_id TEXT NOT NULL,
            UNIQUE (automation_id, version)
        );
        CREATE TABLE automation_runs (
            id TEXT PRIMARY KEY, automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
            version INTEGER NOT NULL DEFAULT 1, user_id TEXT NOT NULL DEFAULT 'u', trigger_kind TEXT NOT NULL DEFAULT 'manual',
            mode TEXT NOT NULL DEFAULT 'live', status TEXT NOT NULL DEFAULT 'queued',
            parent_run_id TEXT, root_run_id TEXT,
            finished_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE automation_run_steps (
            run_id TEXT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE, step_id TEXT NOT NULL,
            step_type TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (run_id, step_id, attempts)
        );
    `);
    await up({ exec: (sql) => pg.exec(sql) });

    const def = (ns) => JSON.stringify({ trigger: { kind: 'manual' }, ...(ns ? { notificationSettings: ns } : {}) });
    await pg.query(`INSERT INTO automations (id, user_id, organization_id, title, definition_json, schedule_tz) VALUES
        ('a1', 'owner', 'org1', 'Invoices', $1, 'Europe/Amsterdam'),
        ('a2', 'owner', 'org1', 'Files', $2, 'UTC'),
        ('a3', 'owner', 'org1', 'Trashed', $1, 'UTC'),
        ('a4', 'owner', 'org1', 'Block', $1, 'UTC')`,
    [def({ digest: { enabled: true, time: '17:00' } }), def({ digest: { enabled: false } })]);
    await pg.query(`UPDATE automations SET deleted_at = NOW() WHERE id = 'a3'`);
    await pg.query(`UPDATE automations SET kind = 'block' WHERE id = 'a4'`);
});

after(async () => { await pg.close(); });

test('the throttle counts messages in the window, not channel rows, and never held rows', async () => {
    await store.recordNotificationEvents([
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'bell', createdAt: at(0), delivered: true },
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'email', createdAt: at(0), delivered: false },
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'bell', createdAt: at(10), bundled: true },
        { automationId: 'a1', event: 'onError', recipient: 'ann', channel: 'bell', createdAt: at(5), delivered: true },
        { automationId: 'a1', event: 'onSuccess', recipient: 'owner', channel: 'bell', createdAt: at(5), delivered: true },
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'bell', createdAt: at(-90), delivered: true },
    ]);
    assert.equal(await store.countRecentMessages({ automationId: 'a1', event: 'onError', recipient: 'owner', since: at(-60) }), 1);
    assert.equal(await store.countRecentMessages({ automationId: 'a1', event: 'onError', recipient: 'owner', since: at(-120) }), 2);
    assert.equal(await store.countRecentMessages({ automationId: 'a1', event: 'onError', recipient: 'nobody', since: at(-60) }), 0);
});

test('a failed attempt is stored with no delivered_at', async () => {
    const recent = await store.listRecentNotificationEvents('a1', { limit: 50 });
    const failed = recent.find(e => e.channel === 'email');
    assert.equal(failed.deliveredAt, null);
    const ok = recent.find(e => e.channel === 'bell' && e.recipient === 'ann');
    assert.equal(ok.deliveredAt, ok.createdAt);
    assert.equal(recent[0].createdAt >= recent[recent.length - 1].createdAt, true, 'newest first');
});

test('pending bundles group per automation, event and recipient; digest-only rows are not bundles', async () => {
    await store.recordNotificationEvents([
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'email', createdAt: at(10), bundled: true },
        { automationId: 'a1', event: 'onError', recipient: 'owner', channel: 'bell', createdAt: at(20), bundled: true },
        { automationId: 'a1', event: 'onSuccess', recipient: 'owner', channel: 'digest', createdAt: at(21), bundled: true },
        { automationId: 'a2', event: 'onError', recipient: 'talk:room1', channel: 'talk', createdAt: at(22), bundled: true, urgency: 'urgent' },
    ]);
    const groups = await store.listPendingBundles();
    assert.equal(groups.length, 2);
    const g = groups.find(x => x.automationId === 'a1');
    assert.equal(g.event, 'onError');
    assert.equal(g.recipient, 'owner');
    assert.equal(g.count, 2, 'two held messages (10 and 20), three rows');
    assert.deepEqual([...g.channels].sort(), ['bell', 'email']);
    assert.equal(g.ids.length, 3);
    const talk = groups.find(x => x.automationId === 'a2');
    assert.deepEqual(talk.channels, ['talk']);

    assert.equal(await store.markEventsReported(g.ids, at(70)), 3);
    assert.equal(await store.markEventsReported(g.ids, at(71)), 0, 'reported once');
    assert.deepEqual((await store.listPendingBundles()).map(x => x.automationId), ['a2']);
});

test('held rows for the digest: every unreported held row of those automations', async () => {
    const held = await store.listHeldForDigest({ recipient: 'owner', automationIds: ['a1'] });
    assert.deepEqual(held.map(h => h.channel), ['digest']);
    assert.equal(held[0].bundled, true);
    assert.deepEqual(await store.listHeldForDigest({ recipient: 'owner', automationIds: [] }), []);
});

test('digest automations: switched on, automations only, trash excluded', async () => {
    const rows = await store.listDigestAutomations();
    assert.deepEqual(rows.map(r => r.id), ['a1']);
    assert.equal(rows[0].scheduleTz, 'Europe/Amsterdam');
    assert.equal(rows[0].notificationSettings.digest.time, '17:00');
    assert.equal(rows[0].organizationId, 'org1');
});

test('the last summary is per recipient and automation', async () => {
    assert.equal(await store.lastDigestAt('owner', ['a1']), null);
    await store.recordNotificationEvents([
        { automationId: 'a1', event: 'digest', recipient: 'owner', channel: 'bell', createdAt: at(420), delivered: true },
    ]);
    assert.equal(await store.lastDigestAt('owner', ['a1']), at(420).toISOString());
    assert.equal(await store.lastDigestAt('owner', ['a2']), null);
    assert.equal(await store.lastDigestAt('ann', ['a1']), null);
});

test('run statistics: live, not tests, journey heads only; waiting counts whenever it started', async () => {
    await pg.query(`INSERT INTO automation_runs (id, automation_id, status, mode, created_at) VALUES
        ('r1', 'a1', 'success', 'live', $1),
        ('r2', 'a1', 'error', 'live', $1),
        ('r3', 'a1', 'error', 'dry_run', $1),
        ('r5', 'a1', 'awaiting_approval', 'live', $2),
        ('r6', 'a1', 'success', 'live', $2),
        ('r7', 'a2', 'awaiting_form', 'live', $1)`, [at(60).toISOString(), at(-3000).toISOString()]);
    await pg.query(`INSERT INTO automation_runs (id, automation_id, status, mode, created_at, is_test) VALUES ('r4', 'a1', 'error', 'live', $1, TRUE)`, [at(60).toISOString()]);
    await pg.query(`INSERT INTO automation_runs (id, automation_id, status, mode, created_at, parent_run_id) VALUES ('r8', 'a1', 'error', 'live', $1, 'r1')`, [at(60).toISOString()]);
    await pg.query(`INSERT INTO automation_runs (id, automation_id, status, mode, created_at, root_run_id) VALUES ('r9', 'a1', 'success', 'live', $1, 'r1')`, [at(60).toISOString()]);

    const stats = await store.digestRunStats({ automationIds: ['a1', 'a2', 'a3'], since: at(0) });
    assert.deepEqual(stats.get('a1'), { runs: 2, failures: 1, waiting: 1 });
    assert.deepEqual(stats.get('a2'), { runs: 1, failures: 0, waiting: 1 });
    assert.equal(stats.has('a3'), false);
    assert.equal((await store.digestRunStats({ automationIds: [], since: at(0) })).size, 0);
});

test('the purge drops rows older than the retention', async () => {
    await pg.query(`INSERT INTO automation_notification_events (id, automation_id, event, recipient_user_id, channel, created_at)
                    VALUES ('old1', 'a1', 'onError', 'owner', 'bell', NOW() - INTERVAL '40 days')`);
    assert.equal(await store.purgeNotificationEvents({ days: 30 }), 1);
    const left = await pg.query(`SELECT COUNT(*)::int AS n FROM automation_notification_events WHERE id = 'old1'`);
    assert.equal(left.rows[0].n, 0);
});

test('rows without the required fields are not written', async () => {
    assert.equal(await store.recordNotificationEvents([{ automationId: 'a1', event: 'onError', channel: 'bell' }, null]), 0);
    assert.equal(await store.recordNotificationEvents([]), 0);
});
