/**
 * notebookConversationStore — message_count + locked-history tests.
 *
 * message_count exists because the blob is encrypted at rest, so the overview
 * cards can't COUNT() messages in SQL. Writers must set it ABSOLUTELY to the
 * array they persist (self-healing for pre-existing rows), never increment.
 *
 * `locked` tells the UI the stored blob is an encryption envelope that decode
 * could not open (no/wrong session DEK) — before this, a DEK-less request
 * silently rendered an empty chat over a full history.
 *
 * Run: node --test stores/notebookConversationStore.count.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

// ── In-memory fake of server/db.js (same shape as the sibling test) ────
const rows = new Map(); // id -> row

function _findByNbUser(notebookId, userId) {
    for (const r of rows.values()) {
        if (r.notebook_id === notebookId && r.user_id === userId) return r;
    }
    return null;
}

const mockDb = {
    exec: async () => {},
    run: async (sql, params) => {
        if (/INSERT INTO notebook_conversations/i.test(sql)) {
            const [id, notebookId, userId] = params;
            if (_findByNbUser(notebookId, userId)) return { rowCount: 0 };
            rows.set(id, { id, notebook_id: notebookId, user_id: userId, messages_json: '[]', message_count: 0 });
            return { rowCount: 1 };
        }
        if (/UPDATE notebook_conversations SET messages_json/i.test(sql)) {
            const [stored, count, id] = params;
            const r = rows.get(id);
            if (!r) return { rowCount: 0 };
            r.messages_json = stored;
            r.message_count = count;
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
    getOne: async (sql, params) => {
        if (/SELECT \* FROM notebook_conversations/i.test(sql)) {
            const [notebookId, userId] = params;
            return _findByNbUser(notebookId, userId);
        }
        return null;
    },
    getAll: async () => [],
};

const dbResolved = require.resolve(path.join(__dirname, '..', 'db.js'));
require.cache[dbResolved] = { id: dbResolved, filename: dbResolved, loaded: true, exports: mockDb };

// decryptAudit registers a non-unref'd cleanup interval at require time, which
// keeps the test process alive forever (why the sibling store test sits in the
// CI NEEDS_INFRA bucket). Stub it — this suite asserts counts, not auditing.
const auditResolved = require.resolve(path.join(__dirname, '..', 'auth', 'decryptAudit.js'));
require.cache[auditResolved] = {
    id: auditResolved, filename: auditResolved, loaded: true,
    exports: { trackDecrypt: () => {}, getDecryptStats: () => null },
};

// ── Encryption policy stand-in ─────────────────────────────────────────
// The store now asks the policy layer whether to encrypt rather than
// encrypting whenever a session DEK happened to be present. These tests are
// about the locked-history guard and the counter, so the policy is pinned ON
// for whichever key the caller passes — that is the state in which a locked
// history can exist at all.
let notebookPolicy = null;
const cryptoResolved = require.resolve(path.join(__dirname, 'agent', 'messageCrypto.js'));
require.cache[cryptoResolved] = {
    id: cryptoResolved, filename: cryptoResolved, loaded: true,
    exports: {
        async resolveCrypto({ encryptionKey = null } = {}) {
            if (notebookPolicy) return notebookPolicy;
            // Mirror `managed`: the caller's key is the one key, and writes are
            // encrypted whenever one is available.
            const key = encryptionKey ? Buffer.from(String(encryptionKey), 'base64') : null;
            return { key, backgroundKey: key, encryptNotebookMessages: !!key, tier: key ? 'managed' : 'none' };
        },
    },
};

const store = require('./notebookConversationStore');

const DEK = Buffer.alloc(32, 7).toString('base64');
const msg = (i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });

test('appendMessages sets message_count to the FULL persisted length', async () => {
    rows.clear();
    await store.appendMessages('nb1', 'u1', DEK, [msg(0), msg(1)]);
    assert.strictEqual(_findByNbUser('nb1', 'u1').message_count, 2);
    await store.appendMessages('nb1', 'u1', DEK, [msg(2), msg(3)]);
    assert.strictEqual(_findByNbUser('nb1', 'u1').message_count, 4, 'absolute, not incremental');
});

test('append self-heals a stale counter (pre-existing rows start at 0)', async () => {
    rows.clear();
    await store.appendMessages('nb2', 'u2', null, [msg(0), msg(1), msg(2)]);
    _findByNbUser('nb2', 'u2').message_count = 0;   // simulate pre-migration row
    await store.appendMessages('nb2', 'u2', null, [msg(3)]);
    assert.strictEqual(_findByNbUser('nb2', 'u2').message_count, 4);
});

test('replaceMessages sets the count absolutely, including down to 0', async () => {
    rows.clear();
    await store.appendMessages('nb3', 'u3', DEK, [msg(0), msg(1), msg(2), msg(3)]);
    await store.replaceMessages('nb3', 'u3', DEK, [msg(0), msg(1)]);
    assert.strictEqual(_findByNbUser('nb3', 'u3').message_count, 2);
    await store.replaceMessages('nb3', 'u3', DEK, []);
    assert.strictEqual(_findByNbUser('nb3', 'u3').message_count, 0);
});

// ── locked detection ──────────────────────────────────────────────
test('locked: encrypted blob without a DEK reports locked, not silently empty', async () => {
    rows.clear();
    await store.appendMessages('nb4', 'u4', DEK, [msg(0), msg(1)]);
    const noKey = await store.getMessagesWithMeta('nb4', 'u4', null);
    assert.deepStrictEqual(noKey.messages, []);
    assert.strictEqual(noKey.locked, true);
});

test('locked: the right DEK opens the history', async () => {
    rows.clear();
    await store.appendMessages('nb5', 'u5', DEK, [msg(0), msg(1)]);
    const opened = await store.getMessagesWithMeta('nb5', 'u5', DEK);
    assert.strictEqual(opened.locked, false);
    assert.strictEqual(opened.messages.length, 2);
});

test('locked: a wrong DEK reads as locked (auth failure, not empty history)', async () => {
    rows.clear();
    await store.appendMessages('nb6', 'u6', DEK, [msg(0)]);
    const wrong = await store.getMessagesWithMeta('nb6', 'u6', Buffer.alloc(32, 9).toString('base64'));
    assert.deepStrictEqual(wrong.messages, []);
    assert.strictEqual(wrong.locked, true);
});

test('locked: plaintext history is never locked', async () => {
    rows.clear();
    await store.appendMessages('nb7', 'u7', null, [msg(0)]);
    const plain = await store.getMessagesWithMeta('nb7', 'u7', null);
    assert.strictEqual(plain.locked, false);
    assert.strictEqual(plain.messages.length, 1);
});

test('locked: no conversation row at all → empty and unlocked', async () => {
    rows.clear();
    const none = await store.getMessagesWithMeta('nb8', 'u8', DEK);
    assert.deepStrictEqual(none, { messages: [], locked: false });
});

// ── locked-append guard (write path) ─────────────────────────────
// Before the guard, a no/wrong-DEK append decoded the envelope to [] and the
// UPDATE replaced the still-recoverable ciphertext with only the new turn —
// re-stored as PLAINTEXT (encryptMessages passes through on a null key).
test('append without a DEK onto an encrypted history throws HISTORY_LOCKED before any write', async () => {
    rows.clear();
    await store.appendMessages('nb9', 'u9', DEK, [msg(0), msg(1)]);
    const before = _findByNbUser('nb9', 'u9').messages_json;
    await assert.rejects(
        () => store.appendMessages('nb9', 'u9', null, [msg(2)]),
        (err) => err.code === 'HISTORY_LOCKED',
    );
    const r = _findByNbUser('nb9', 'u9');
    assert.strictEqual(r.messages_json, before, 'the encrypted blob must be untouched');
    assert.strictEqual(r.message_count, 2, 'the counter must be untouched');
    // The whole point of refusing: the original DEK still opens the history.
    const opened = await store.getMessagesWithMeta('nb9', 'u9', DEK);
    assert.strictEqual(opened.locked, false);
    assert.deepStrictEqual(opened.messages, [msg(0), msg(1)]);
});

test('append with a WRONG DEK throws HISTORY_LOCKED and the original DEK still decrypts', async () => {
    rows.clear();
    await store.appendMessages('nb10', 'u10', DEK, [msg(0)]);
    const before = _findByNbUser('nb10', 'u10').messages_json;
    await assert.rejects(
        () => store.appendMessages('nb10', 'u10', Buffer.alloc(32, 9).toString('base64'), [msg(1)]),
        (err) => err.code === 'HISTORY_LOCKED',
    );
    assert.strictEqual(_findByNbUser('nb10', 'u10').messages_json, before);
    const opened = await store.getMessagesWithMeta('nb10', 'u10', DEK);
    assert.strictEqual(opened.locked, false);
    assert.deepStrictEqual(opened.messages, [msg(0)]);
});

test('encrypted-but-EMPTY history with the right DEK is not locked: append succeeds', async () => {
    rows.clear();
    await store.appendMessages('nb11', 'u11', DEK, [msg(0)]);
    // replace is intentionally destructive — leaves an encrypted empty array.
    await store.replaceMessages('nb11', 'u11', DEK, []);
    const merged = await store.appendMessages('nb11', 'u11', DEK, [msg(1), msg(2)]);
    assert.deepStrictEqual(merged, [msg(1), msg(2)]);
    assert.strictEqual(_findByNbUser('nb11', 'u11').message_count, 2);
    const opened = await store.getMessagesWithMeta('nb11', 'u11', DEK);
    assert.strictEqual(opened.locked, false);
    assert.strictEqual(opened.messages.length, 2);
});
