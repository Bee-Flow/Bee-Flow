// @typecheck
/**
 * supportInboxStore — removing a mailbox must not leak into the company inbox,
 * against a real Postgres (PGlite behind db.js's pool, testUtils/pglitePool.js).
 *
 * Bee Flow's OWN support inbox is defined as `inbox_id IS NULL` (see
 * routes/support.js GET /threads). Detaching a removed mailbox's tickets by
 * nulling inbox_id is exactly that predicate: deleting a tenant mailbox would
 * publish every one of its emails into the super-admin's Customer Support
 * panel. So the mailbox's tickets are purged, never detached, and only once
 * the org-scoped write actually matched the inbox, so a wrong-org caller can
 * never delete another tenant's tickets.
 *
 * Run: cd server && node --test stores/supportInboxStore.disconnect.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

const { usePglitePool } = require('../testUtils/pglitePool');

const { pg, close } = usePglitePool();
const { initDB: initSupport } = require('./supportStore/schema');
const store = require('./supportInboxStore');

test.before(async () => {
    await initSupport();
    await store.initDB();
});
test.after(close);

async function inbox(org = 'org-1') {
    const { rows } = await pg.query(
        `INSERT INTO support_inboxes (organization_id, created_by, provider, encrypted_tokens, active, gmail_history_id, graph_delta_link, sync_locked_until)
         VALUES ($1, 'u1', 'gmail', 'sealed-tokens', true, 'h1', 'd1', NOW() + INTERVAL '5 minutes') RETURNING id`, [org]);
    return rows[0].id;
}
async function ticket(inboxId) {
    await pg.query(
        `INSERT INTO support_threads (organization_id, requester_email, source, subject, inbox_id)
         VALUES ('org-1', 'r@example.test', 'in_app', 'Mail', $1)`, [inboxId]);
}
const ticketsOf = async (inboxId) => Number((await pg.query(
    'SELECT COUNT(*)::int AS n FROM support_threads WHERE inbox_id IS NOT DISTINCT FROM $1', [inboxId],
)).rows[0].n);
const companyInbox = () => ticketsOf(null);

test('deleteInbox purges the mailbox threads instead of detaching them', async () => {
    const id = await inbox();
    const other = await inbox();
    await ticket(id);
    await ticket(other);
    const company = await companyInbox();

    assert.deepStrictEqual(await store.deleteInbox(id, 'org-1'), { ok: true, purgedThreads: 1 });
    assert.strictEqual(await ticketsOf(id), 0, 'the inbox threads are deleted');
    assert.strictEqual(await companyInbox(), company, 'a removed mailbox never detaches its threads into the company inbox');
    assert.strictEqual(await ticketsOf(other), 1, "another inbox's tickets stay");
    assert.strictEqual((await pg.query('SELECT 1 FROM support_inboxes WHERE id = $1', [id])).rows.length, 0);
});

test('deleteInbox touches nothing when the org scope does not match', async () => {
    const id = await inbox();
    await ticket(id);
    assert.deepStrictEqual(await store.deleteInbox(id, 'other-org'), { ok: false, purgedThreads: 0 });
    assert.strictEqual(await ticketsOf(id), 1, "a wrong-org delete must not reach another tenant's tickets");
    assert.strictEqual((await pg.query('SELECT 1 FROM support_inboxes WHERE id = $1', [id])).rows.length, 1);
});

test('disconnectInbox shreds the tokens, stops the sync and purges the tickets; the inbox row survives', async () => {
    const id = await inbox();
    await ticket(id);
    await ticket(id);
    const company = await companyInbox();

    assert.deepStrictEqual(await store.disconnectInbox(id, 'org-1'), { ok: true, purgedThreads: 2 });
    const { rows } = await pg.query(
        'SELECT encrypted_tokens, active, gmail_history_id, graph_delta_link, sync_locked_until FROM support_inboxes WHERE id = $1', [id]);
    assert.deepStrictEqual(rows[0], { encrypted_tokens: null, active: false, gmail_history_id: null, graph_delta_link: null, sync_locked_until: null },
        'tokens dropped, the sync stops picking it up, and a stale lease does not block a reconnect');
    assert.strictEqual(await ticketsOf(id), 0);
    assert.strictEqual(await companyInbox(), company);
});

test('disconnectInbox touches nothing when the org scope does not match', async () => {
    const id = await inbox();
    await ticket(id);
    assert.deepStrictEqual(await store.disconnectInbox(id, 'other-org'), { ok: false, purgedThreads: 0 });
    assert.strictEqual(await ticketsOf(id), 1);
    assert.strictEqual((await pg.query('SELECT encrypted_tokens FROM support_inboxes WHERE id = $1', [id])).rows[0].encrypted_tokens, 'sealed-tokens');
});
