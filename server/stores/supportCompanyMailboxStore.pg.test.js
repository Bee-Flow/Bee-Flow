// @typecheck
/**
 * The company mailbox row against a REAL Postgres (@electric-sql/pglite) and
 * the sync's cursor handling with a fake IMAP client.
 *
 *   - The public read never carries a password; the secret read decrypts it.
 *   - Saving the same account keeps the IMAP cursor; another host or user
 *     name starts over from now.
 *   - The lease is exclusive until released.
 *   - A first sync reads from the connect moment (older mail on that day is
 *     history), moves the cursor per message, and the next sync asks only
 *     for what came after it. A changed UIDVALIDITY restarts the cursor.
 *
 * Run: cd server && node --test stores/supportCompanyMailboxStore.pg.test.js
 */

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-at-least-32-characters-long';

const { newPglite } = require('../testUtils/pgliteTemplate');
const { usePglitePool } = require('../testUtils/pglitePool');

const pg = newPglite();
const { query, restore: restorePool } = usePglitePool(pg);
const store = require('./supportCompanyMailboxStore');
const { syncCompanyMailbox } = require('../services/supportCompanyMailbox/sync.mts');

const INPUT = {
    emailAddress: 'support@example.test',
    displayName: 'Support',
    imap: { host: 'imap.example.test', port: 993, security: /** @type {const} */ ('tls'), folder: 'INBOX' },
    smtp: { host: 'smtp.example.test', port: 587, security: /** @type {const} */ ('starttls') },
    username: 'support@example.test',
    smtpUsername: null,
    secrets: { password: 'imap-secret', smtpPassword: null },
    aiAutoReply: false,
    createdBy: 'admin-1',
};

before(async () => {
    await pg.exec("SET TIME ZONE 'UTC'");
    await store.initDB();
});

beforeEach(async () => { await query('DELETE FROM support_company_mailbox'); });

after(async () => {
    restorePool();
    await pg.close();
});

test('the public read has no password; the secret read decrypts it', async () => {
    const saved = await store.saveMailbox(INPUT);
    assert.strictEqual(saved.emailAddress, 'support@example.test');
    assert.ok(!JSON.stringify(saved).includes('imap-secret'));
    assert.ok(!JSON.stringify(await store.getMailbox()).includes('imap-secret'));
    const { rows } = await query('SELECT encrypted_secrets FROM support_company_mailbox');
    assert.ok(!String(rows[0].encrypted_secrets).includes('imap-secret'), 'stored encrypted');
    const full = await store.getMailboxWithSecrets();
    assert.strictEqual(full?.secrets.password, 'imap-secret');
});

test('the cursor survives a save of the same account and restarts for another one', async () => {
    await store.saveMailbox(INPUT);
    await store.setCursor({ uidValidity: '42', lastUid: 17 });
    await store.saveMailbox({ ...INPUT, displayName: 'Helpdesk', aiAutoReply: true });
    let full = await store.getMailboxWithSecrets();
    assert.strictEqual(full?.lastUid, 17);
    assert.strictEqual(full?.aiAutoReply, true);
    await store.saveMailbox({ ...INPUT, imap: { ...INPUT.imap, host: 'imap.other.test' } });
    full = await store.getMailboxWithSecrets();
    assert.strictEqual(full?.lastUid, null);
    assert.strictEqual(full?.uidValidity, null);
});

test('the lease is exclusive until released, and deleting removes the row', async () => {
    await store.saveMailbox(INPUT);
    assert.strictEqual(await store.acquireSyncLock(10), true);
    assert.strictEqual(await store.acquireSyncLock(10), false);
    await store.releaseSyncLock();
    assert.strictEqual(await store.acquireSyncLock(10), true);
    assert.strictEqual(await store.deleteMailbox(), true);
    assert.strictEqual(await store.getMailbox(), null);
    assert.strictEqual(await store.acquireSyncLock(10), false, 'no mailbox, no lease');
});

/**
 * A fake ImapFlow over `messages` (uid → { internalDate, size }).
 * @param {Record<number, { internalDate: Date, size?: number }>} messages
 * @param {string} uidValidity
 */
function fakeImap(messages, uidValidity) {
    /** @type {unknown[]} */
    const searches = [];
    const client = {
        mailbox: { uidValidity },
        searches,
        getMailboxLock: async () => ({ release() {} }),
        search: async (/** @type {{ since?: Date, uid?: string }} */ q) => {
            searches.push(q);
            const uids = Object.keys(messages).map(Number);
            if (q.uid) {
                const from = Number(q.uid.split(':')[0]);
                const hits = uids.filter((u) => u >= from);
                return hits.length ? hits : [Math.max(...uids)]; // n:* always answers the newest
            }
            const day = new Date(q.since || 0); day.setUTCHours(0, 0, 0, 0);
            return uids.filter((u) => messages[u].internalDate >= day);
        },
        fetchOne: async (/** @type {string} */ uid, /** @type {Record<string, boolean>} */ what) => {
            const m = messages[Number(uid)];
            if (!m) return null;
            return what.source ? { source: Buffer.from(`uid ${uid}`) } : { uid: Number(uid), size: m.size || 100, internalDate: m.internalDate, envelope: {} };
        },
        logout: async () => {},
    };
    return client;
}

test('sync: from the connect moment, cursor per message, then only what follows; a new UIDVALIDITY restarts', async () => {
    await store.saveMailbox(INPUT);
    const connectedAt = new Date(Date.now() - 60_000);
    await query('UPDATE support_company_mailbox SET sync_after = $1', [connectedAt]);
    const earlier = new Date(connectedAt.getTime() - 30 * 60_000);
    const later = new Date(connectedAt.getTime() + 10_000);
    const messages = { 3: { internalDate: earlier }, 4: { internalDate: later }, 5: { internalDate: later } };
    /** @type {string[]} */
    const ingested = [];
    let imap = fakeImap(messages, '42');
    const deps = {
        open: async () => /** @type {any} */ (imap),
        parse: async (/** @type {Buffer} */ src) => ({ messageId: `<${src.toString()}@x>`, from: { value: [{ address: 'c@customer.test' }] }, text: 'hi', headerLines: [] }),
        ingest: async (/** @type {{ providerMessageId: string }} */ n) => { ingested.push(n.providerMessageId); return 'created'; },
    };

    let out = await syncCompanyMailbox(/** @type {any} */ (deps));
    assert.strictEqual(out.error, undefined);
    assert.deepStrictEqual(out.results, ['skipped:before_connect', 'created', 'created']);
    assert.deepStrictEqual(ingested, ['imap:42:4', 'imap:42:5']);
    let full = await store.getMailboxWithSecrets();
    assert.strictEqual(full?.lastUid, 5);
    assert.strictEqual(full?.syncStatus, 'idle');

    out = await syncCompanyMailbox(/** @type {any} */ (deps));
    assert.deepStrictEqual(out.results, [], 'n:* answering the newest (5) is not read again');
    assert.deepStrictEqual(imap.searches.at(-1), { uid: '6:*' });

    imap = fakeImap({ 1: { internalDate: later } }, '99');
    out = await syncCompanyMailbox(/** @type {any} */ (deps));
    assert.deepStrictEqual(ingested.at(-1), 'imap:99:1');
    full = await store.getMailboxWithSecrets();
    assert.strictEqual(full?.uidValidity, '99');
    assert.strictEqual(full?.lastUid, 1);
});

test('sync: a failure lands on the row as an error and releases the lease', async () => {
    await store.saveMailbox(INPUT);
    const out = await syncCompanyMailbox(/** @type {any} */ ({ open: async () => { throw new Error('IMAP: the server refused the user name or password.'); }, parse: async () => ({}), ingest: async () => '' }));
    assert.match(String(out.error), /refused/);
    const mb = await store.getMailbox();
    assert.strictEqual(mb?.syncStatus, 'error');
    assert.strictEqual(await store.acquireSyncLock(10), true, 'lease released');
});
