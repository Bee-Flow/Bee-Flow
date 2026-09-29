/**
 * supportInboxStore — removing a mailbox must not leak into the company inbox.
 *
 * Bee Flow's OWN support inbox is defined as `inbox_id IS NULL` (see
 * routes/support.js GET /threads). deleteInbox used to "detach" the removed
 * mailbox's tickets with `UPDATE support_threads SET inbox_id = NULL`, which is
 * exactly that predicate — so deleting a tenant mailbox published every one of
 * its emails (receipts, calendar invites, private customer mail) into the
 * super-admin's Customer Support panel.
 *
 * These tests pin the two properties that keeps closed:
 *   1. no statement ever nulls inbox_id, and
 *   2. the thread purge only runs once the org-scoped write actually matched a
 *      row, so a wrong-org caller can never delete another tenant's tickets.
 *
 * No live DB: `../db` is stubbed with a recording pool.
 *
 * Run: node --test stores/supportInboxStore.disconnect.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'x'.repeat(48);

// Recording pool. `rowCounts` lets a case say what the scoped write matched.
const queries = [];
let rowCountFor = () => 1;

const pool = {
    query: async (sql, params = []) => {
        queries.push({ sql: String(sql), params });
        return { rows: [], rowCount: rowCountFor(String(sql), params) };
    },
};

const restore = installResolveStub({ '../db': { pool, makeStoreInit: () => async () => {} } });
const store = require('./supportInboxStore');
// initDB runs the CREATE TABLE batch through the same stub; harmless.

function reset(counts = () => 1) {
    queries.length = 0;
    rowCountFor = counts;
}

const mutations = () => queries.filter(q => /^\s*(UPDATE|DELETE|INSERT)/i.test(q.sql));

test('deleteInbox purges the mailbox threads instead of detaching them', async () => {
    reset();
    const res = await store.deleteInbox('inbox-1', 'org-1');

    assert.deepStrictEqual(res, { ok: true, purgedThreads: 1 });

    // The regression: nothing may set inbox_id = NULL.
    assert.ok(
        !mutations().some(q => /inbox_id\s*=\s*NULL/i.test(q.sql)),
        'a removed mailbox must never detach its threads into the company inbox'
    );

    const threadWrite = mutations().find(q => /support_threads/i.test(q.sql));
    assert.ok(threadWrite, 'the inbox threads must be deleted');
    assert.match(threadWrite.sql, /^\s*DELETE FROM support_threads WHERE inbox_id = \$1/i);
    assert.deepStrictEqual(threadWrite.params, ['inbox-1']);

    const inboxWrite = mutations().find(q => /support_inboxes/i.test(q.sql));
    assert.match(inboxWrite.sql, /organization_id = \$2/i, 'the inbox delete stays org-scoped');
    assert.deepStrictEqual(inboxWrite.params, ['inbox-1', 'org-1']);
});

test('deleteInbox touches no threads when the org scope does not match', async () => {
    // The scoped DELETE matches nothing — a caller from another org.
    reset(sql => (/support_inboxes/i.test(sql) ? 0 : 1));
    const res = await store.deleteInbox('inbox-1', 'other-org');

    assert.deepStrictEqual(res, { ok: false, purgedThreads: 0 });
    assert.ok(
        !mutations().some(q => /support_threads/i.test(q.sql)),
        'a wrong-org delete must not reach another tenant\'s tickets'
    );
});

test('disconnectInbox shreds the tokens, stops the sync and purges the tickets', async () => {
    reset(() => 2);
    const res = await store.disconnectInbox('inbox-2', 'org-1');

    assert.deepStrictEqual(res, { ok: true, purgedThreads: 2 });

    const inboxWrite = mutations().find(q => /support_inboxes/i.test(q.sql));
    assert.match(inboxWrite.sql, /encrypted_tokens = NULL/i, 'the OAuth tokens must be dropped');
    assert.match(inboxWrite.sql, /active = false/i, 'getDueInboxes must stop picking the row up');
    assert.match(inboxWrite.sql, /gmail_history_id = NULL/i);
    assert.match(inboxWrite.sql, /graph_delta_link = NULL/i);
    assert.match(inboxWrite.sql, /sync_locked_until = NULL/i, 'a stale lease must not block a reconnect');
    assert.match(inboxWrite.sql, /organization_id = \$2/i, 'the disconnect stays org-scoped');
    assert.deepStrictEqual(inboxWrite.params, ['inbox-2', 'org-1']);

    // The inbox row survives — settings, access and KB wiring outlive a reconnect.
    assert.ok(!mutations().some(q => /DELETE FROM support_inboxes/i.test(q.sql)));

    const threadWrite = mutations().find(q => /support_threads/i.test(q.sql));
    assert.match(threadWrite.sql, /^\s*DELETE FROM support_threads WHERE inbox_id = \$1/i);
    assert.ok(!mutations().some(q => /inbox_id\s*=\s*NULL/i.test(q.sql)));
});

test('disconnectInbox touches no threads when the org scope does not match', async () => {
    reset(sql => (/support_inboxes/i.test(sql) ? 0 : 1));
    const res = await store.disconnectInbox('inbox-2', 'other-org');

    assert.deepStrictEqual(res, { ok: false, purgedThreads: 0 });
    assert.ok(!mutations().some(q => /support_threads/i.test(q.sql)));
});

test.after(() => restore());
