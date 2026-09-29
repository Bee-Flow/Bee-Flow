/**
 * automation_shares against a real Postgres (@electric-sql/pglite,
 * in-process). The store is built with makeSharesStore over the PGlite
 * handle: no module mocking.
 *
 * Proven:
 *   - replace writes the whole list in one go, keeps unchanged rows and drops
 *     the ones that are gone;
 *   - "shared with me" finds direct and group shares, reports the strongest
 *     role, names the owner, and leaves out the caller's own routines, trashed
 *     routines, other organisations and org-less routines of other orgs;
 *   - member counts per group, over active members of the organisation only;
 *   - a transfer moves the owner, drops the new owner's share, keeps the old
 *     owner as editor, and refuses when the owner already changed.
 *
 * Run: cd server && node --test stores/automationStore/shares.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { pgliteDb } = require('../../testUtils/pgliteDb');

const { pg, db } = pgliteDb();

const { up } = require('../../migrations/automation-handoff5-2026-09');
const { makeSharesStore } = require('./shares');

const store = makeSharesStore(db);

async function seedAutomation(id, { userId = 'owner', org = 'org1', deleted = false, updatedAt = '2026-09-01' } = {}) {
    await pg.query(
        `INSERT INTO automations (id, user_id, organization_id, title, definition_json, deleted_at, updated_at)
         VALUES ($1, $2, $3, $1, '{"trigger":{"kind":"manual"}}', $4, $5)`,
        [id, userId, org, deleted ? new Date().toISOString() : null, updatedAt],
    );
}
async function seedUser(id, { org = 'org1', groups = '[]', name = null, status = 'active' } = {}) {
    await pg.query(
        `INSERT INTO users (id, username, "displayName", "organizationId", groups, status) VALUES ($1, $1, $2, $3, $4, $5)`,
        [id, name, org, groups, status],
    );
}

before(async () => {
    await pg.exec(`
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            username TEXT,
            "displayName" TEXT,
            "organizationId" TEXT,
            groups TEXT DEFAULT '[]',
            status TEXT DEFAULT 'active'
        );
        CREATE TABLE automations (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            organization_id TEXT,
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

    await seedUser('owner', { name: 'Olga Owner' });
    await seedUser('ed');
    await seedUser('vic', { groups: '["g-fin"]' });
    await seedUser('fin2', { groups: '["g-fin","g-ops"]' });
    await seedUser('gone', { groups: '["g-fin"]', status: 'disabled' });
    await seedUser('broken', { groups: 'not json' });
    await seedUser('outsider', { org: 'org2', groups: '["g-fin"]' });
});

after(async () => { await pg.close(); });

test('replace writes the whole list, keeps unchanged rows, drops the rest', async () => {
    await seedAutomation('r1');
    let rows = await store.replaceSharesForAutomation('r1', [
        { principalType: 'user', principalId: 'ed', role: 'edit' },
        { principalType: 'group', principalId: 'g-fin', role: 'view' },
    ], 'owner');
    assert.deepStrictEqual(rows.map(r => [r.principalType, r.principalId, r.role]), [['user', 'ed', 'edit'], ['group', 'g-fin', 'view']]);
    const firstId = rows[0].id;

    rows = await store.replaceSharesForAutomation('r1', [
        { principalType: 'user', principalId: 'ed', role: 'run' },
    ], 'owner');
    assert.deepStrictEqual(rows.map(r => [r.principalType, r.principalId, r.role]), [['user', 'ed', 'run']]);
    assert.strictEqual(rows[0].id, firstId, 'an unchanged principal keeps its row');

    rows = await store.replaceSharesForAutomation('r1', [], 'owner');
    assert.deepStrictEqual(rows, []);
});

test('shared with me: direct and group shares, strongest role, owner named', async () => {
    await seedAutomation('s1', { updatedAt: '2026-09-02' });
    await seedAutomation('s2', { updatedAt: '2026-09-03' });
    await seedAutomation('s3-trashed', { deleted: true });
    await seedAutomation('s4-other-org', { org: 'org2', userId: 'x' });
    await seedAutomation('s5-mine', { userId: 'vic' });
    await store.replaceSharesForAutomation('s1', [
        { principalType: 'user', principalId: 'vic', role: 'run' },
        { principalType: 'group', principalId: 'g-fin', role: 'edit' },
    ], 'owner');
    await store.replaceSharesForAutomation('s2', [{ principalType: 'group', principalId: 'g-fin', role: 'view' }], 'owner');
    await store.replaceSharesForAutomation('s3-trashed', [{ principalType: 'user', principalId: 'vic', role: 'edit' }], 'owner');
    await store.replaceSharesForAutomation('s4-other-org', [{ principalType: 'user', principalId: 'vic', role: 'edit' }], 'x');
    await store.replaceSharesForAutomation('s5-mine', [{ principalType: 'group', principalId: 'g-fin', role: 'edit' }], 'vic');

    const rows = await store.listAutomationsSharedWithUser('vic', { orgId: 'org1', groupIds: ['g-fin'] });
    assert.deepStrictEqual(rows.map(r => [r.id, r.myRole]), [['s2', 'view'], ['s1', 'edit']]);
    assert.deepStrictEqual(rows[0].owner, { userId: 'owner', name: 'Olga Owner' });
    assert.strictEqual(typeof rows[0].pendingChanges, 'number', 'the full automation shape');

    const noGroups = await store.listAutomationsSharedWithUser('vic', { orgId: 'org1', groupIds: [] });
    assert.deepStrictEqual(noGroups.map(r => [r.id, r.myRole]), [['s1', 'run']]);

    assert.deepStrictEqual(await store.listAutomationsSharedWithUser('vic', { orgId: null }), []);
});

test('shared with me: a live routine keeps its (non-enumerable) live copy', async () => {
    await seedAutomation('s6-live', { updatedAt: '2026-09-04' });
    await pg.query(
        `UPDATE automations SET live_version = 1, live_definition_json = '{"trigger":{"kind":"schedule"}}' WHERE id = 's6-live'`,
    );
    await store.replaceSharesForAutomation('s6-live', [{ principalType: 'user', principalId: 'rita', role: 'run' }], 'owner');
    const [row] = await store.listAutomationsSharedWithUser('rita', { orgId: 'org1' });
    assert.strictEqual(row.id, 's6-live');
    assert.strictEqual(row.myRole, 'run');
    assert.deepStrictEqual(row.liveDefinition, { trigger: { kind: 'schedule' } }, 'what a run-only caller is shown the triggers of');
    assert.ok(!Object.keys(row).includes('liveDefinition'), 'still never serialised');
});

test('an org-less routine counts in its owner\'s organisation', async () => {
    await seedAutomation('s6-orgless', { org: null });
    await store.replaceSharesForAutomation('s6-orgless', [{ principalType: 'user', principalId: 'ed', role: 'view' }], 'owner');
    const rows = await store.listAutomationsSharedWithUser('ed', { orgId: 'org1' });
    assert.ok(rows.some(r => r.id === 's6-orgless' && r.myRole === 'view'));
    assert.deepStrictEqual(await store.listAutomationsSharedWithUser('ed', { orgId: 'org2' }), []);
});

test('member counts: active members of the organisation, broken group lists count as none', async () => {
    const counts = await store.countGroupMembers('org1', ['g-fin', 'g-ops', 'g-none']);
    assert.strictEqual(counts.get('g-fin'), 2);   // vic, fin2 (not the disabled one, not org2)
    assert.strictEqual(counts.get('g-ops'), 1);
    assert.strictEqual(counts.has('g-none'), false);
});

test('transfer: new owner, their share gone, the old owner keeps edit; a stale transfer is refused', async () => {
    await seedAutomation('t1');
    await store.replaceSharesForAutomation('t1', [
        { principalType: 'user', principalId: 'ed', role: 'edit' },
        { principalType: 'group', principalId: 'g-fin', role: 'view' },
    ], 'owner');
    const moved = await store.transferAutomationOwner('t1', { fromUserId: 'owner', toUserId: 'ed', byUserId: 'owner' });
    assert.strictEqual(moved.userId, 'ed');
    const shares = await store.listSharesForAutomation('t1');
    assert.deepStrictEqual(
        shares.map(s => [s.principalType, s.principalId, s.role]).sort(),
        [['group', 'g-fin', 'view'], ['user', 'owner', 'edit']],
    );
    const again = await store.transferAutomationOwner('t1', { fromUserId: 'owner', toUserId: 'vic', byUserId: 'owner' });
    assert.strictEqual(again, null);
    const [row] = (await pg.query(`SELECT user_id FROM automations WHERE id = 't1'`)).rows;
    assert.strictEqual(row.user_id, 'ed');
});
