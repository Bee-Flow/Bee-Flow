// @typecheck
/**
 * supportInboxStore.getDueInboxes against a real Postgres (@electric-sql/pglite)
 * and the store's own schema.
 *
 * The sync engine used to mark a mailbox sync_status='syncing' before the
 * provider round-trips; a process killed in between left the row there, and
 * getDueInboxes excluded 'syncing' rows, so that mailbox was never due again
 * and stopped producing tickets. The engine no longer writes the marker (the
 * lease, sync_locked_until, is what guards a sync in flight), but the rows an
 * older build wedged stayed invisible until the predicate went too.
 *
 * Run: cd server && node --test stores/supportInboxStore.due.pg.test.js
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

const { newPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const store = require('./supportInboxStore');

async function inbox(address, fields = {}) {
    const row = {
        sync_status: 'idle', sync_locked_until: null, last_sync_at: null, active: true, encrypted_tokens: 'sealed', ...fields,
    };
    await query(
        `INSERT INTO support_inboxes (organization_id, created_by, provider, email_address, sync_status, sync_locked_until, last_sync_at, active, encrypted_tokens)
         VALUES ('org1', 'u1', 'gmail', $1, $2, $3, $4, $5, $6)`,
        [address, row.sync_status, row.sync_locked_until, row.last_sync_at, row.active, row.encrypted_tokens],
    );
}

const hour = 3600_000;

before(async () => {
    await store.initDB();
    await inbox('idle@example.test');
    await inbox('wedged@example.test', { sync_status: 'syncing', last_sync_at: new Date(Date.now() - 48 * hour) });
    await inbox('failed@example.test', { sync_status: 'error', last_sync_at: new Date(Date.now() - hour) });
    await inbox('leased@example.test', { sync_locked_until: new Date(Date.now() + hour) });
    await inbox('lapsed-lease@example.test', { sync_status: 'syncing', sync_locked_until: new Date(Date.now() - hour) });
    await inbox('fresh@example.test', { last_sync_at: new Date() });
    await inbox('inactive@example.test', { active: false });
    await inbox('disconnected@example.test', { encrypted_tokens: null });
});

after(async () => {
    restorePool();
    await pg.close();
});

test('a mailbox left at syncing by a dead process is due again; a live lease still holds one back', async () => {
    const due = (await store.getDueInboxes()).map((r) => r.email_address).sort();
    assert.deepEqual(due, ['failed@example.test', 'idle@example.test', 'lapsed-lease@example.test', 'wedged@example.test']);
});

test('the lease is what keeps two syncs apart', async () => {
    const [{ id }] = (await query(`SELECT id FROM support_inboxes WHERE email_address = 'wedged@example.test'`)).rows;
    assert.deepEqual(await store.acquireSyncLock(id, 10), { acquired: true });
    assert.deepEqual(await store.acquireSyncLock(id, 10), { acquired: false });
    assert.ok(!(await store.getDueInboxes()).some((r) => r.id === id), 'held: not handed out a second time');
    await store.releaseSyncLock(id);
    assert.ok((await store.getDueInboxes()).some((r) => r.id === id));
});

// The history scan is "crash-resumable via a lease": acquireScanLock takes a
// 'running' row whose lease lapsed. getDueScans offered only 'queued' rows, so
// a scan whose process died stayed 'running' for ever, and the route answers
// 409 "already in progress" to every new scan of that mailbox.
test('a scan whose process died is due again once its lease lapses; a live one is not', async () => {
    const ids = {};
    for (const r of (await query('SELECT id, email_address FROM support_inboxes')).rows) ids[r.email_address] = r.id;
    const set = (address, status, until) => query(
        'UPDATE support_inboxes SET scan_status = $2, scan_locked_until = $3 WHERE id = $1', [ids[address], status, until]);
    await set('idle@example.test', 'queued', null);
    await set('wedged@example.test', 'running', new Date(Date.now() - hour));   // died mid-scan
    await set('failed@example.test', 'running', new Date(Date.now() + hour));   // scanning right now
    await set('leased@example.test', 'done', null);
    await set('fresh@example.test', 'error', null);

    const due = (await store.getDueScans()).map((r) => r.email_address).sort();
    assert.deepEqual(due, ['idle@example.test', 'wedged@example.test']);

    assert.deepEqual(await store.acquireScanLock(ids['wedged@example.test'], 30), { acquired: true });
    assert.deepEqual((await store.getDueScans()).map((r) => r.email_address), ['idle@example.test'], 'taken: not handed out twice');
});
