/**
 * Unit tests for notebookConversationStore — encrypted persistence round-trip
 * for in-notebook / legal-dossier chat.
 *
 * NO DATABASE REQUIRED. Three dependencies are redirected through the
 * sanctioned require seam (`testUtils/stubRequire`) BEFORE the store is loaded.
 * The keys below are the require strings exactly AS WRITTEN in the module that
 * issues them — a key that does not match is ignored silently, the real module
 * loads, and you get a pg pool (ECONNREFUSED 127.0.0.1:5432) back:
 *
 *   '../db'                    ← stores/notebookConversationStore.js:35
 *   './agent/messageCrypto'    ← stores/notebookConversationStore.js:37
 *   '../../auth/decryptAudit'  ← stores/agent/messageEncryption.js:7
 *
 * The third stub is not about the database. `auth/decryptAudit` installs a
 * top-level `setInterval` (5-minute cleanup sweep) that is never `.unref()`ed,
 * so merely loading the real module keeps the event loop alive forever: every
 * assertion in this file goes green and then the run dies on the file-level
 * test timeout. Stubbing it out is the whole reason this file terminates.
 *
 * `stores/agent/messageEncryption` stays REAL — the AES-GCM envelope round-trip
 * is precisely what these contracts pin, so stubbing it would prove nothing.
 *
 * Run: node --test server/stores/notebookConversationStore.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── In-memory fake of server/db.js ─────────────────────────────────────
// Models a single notebook_conversations table keyed by id, with the
// UNIQUE(notebook_id, user_id) constraint honoured by getOrCreate's
// ON CONFLICT DO NOTHING.
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
            if (_findByNbUser(notebookId, userId)) return { rowCount: 0 }; // ON CONFLICT DO NOTHING
            rows.set(id, { id, notebook_id: notebookId, user_id: userId, messages_json: '[]' });
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
        if (/DELETE FROM notebook_conversations/i.test(sql)) {
            if (/user_id = \$2/i.test(sql)) {
                const [notebookId, userId] = params;
                const r = _findByNbUser(notebookId, userId);
                if (r) rows.delete(r.id);
            } else {
                const [notebookId] = params;
                for (const [id, r] of [...rows]) if (r.notebook_id === notebookId) rows.delete(id);
            }
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

// ── Encryption policy stand-in ─────────────────────────────────────────────
// The store now asks the policy layer whether to encrypt, instead of
// encrypting whenever a session key happened to exist. That old behaviour
// meant an org on tier `none` still got encrypted notebooks while a keyless
// caller wrote plaintext into a `managed` org that believed itself covered.
//
// `notebookPolicy` drives that decision here; the policy's own resolution is
// covered by stores/agent/messageCrypto.tiers.test.js.
let notebookPolicy = { encryptNotebookMessages: false, key: null, backgroundKey: null, tier: 'none' };

// ── Audit hook stand-in ────────────────────────────────────────────────────
// Pure counter in the real module; the only thing we need gone is its
// never-unref'd cleanup interval (see the header note).
const mockDecryptAudit = {
    trackDecrypt: () => {},
    getDecryptStats: () => null,
};

const restoreRequire = installResolveStub({
    '../db': mockDb,
    './agent/messageCrypto': { async resolveCrypto() { return notebookPolicy; } },
    '../../auth/decryptAudit': mockDecryptAudit,
});
after(restoreRequire);

const store = require('./notebookConversationStore');

// A 32-byte base64 DEK so v2 envelope encryption actually engages.
const DEK = Buffer.alloc(32, 7).toString('base64');

function encryptionOn() {
    notebookPolicy = {
        encryptNotebookMessages: true,
        key: Buffer.from(DEK, 'base64'),
        backgroundKey: Buffer.from(DEK, 'base64'),
        tier: 'managed',
    };
}
function encryptionOff() {
    notebookPolicy = { encryptNotebookMessages: false, key: null, backgroundKey: null, tier: 'none' };
}
test.beforeEach(encryptionOff);

test('append then read returns the same messages (plaintext path, no key)', async () => {
    rows.clear();
    await store.appendMessages('nb1', 'u1', null, [
        { role: 'user', content: 'hallo' },
        { role: 'assistant', content: 'hoi' },
    ]);
    const got = await store.getMessages('nb1', 'u1', null);
    assert.deepStrictEqual(got.map(m => [m.role, m.content]), [['user', 'hallo'], ['assistant', 'hoi']]);
});

test('blob is encrypted at rest when the POLICY says so, and round-trips', async () => {
    rows.clear();
    encryptionOn();
    await store.appendMessages('nb2', 'u2', DEK, [{ role: 'user', content: 'BSN 123456782' }]);
    const raw = _findByNbUser('nb2', 'u2').messages_json;
    assert.ok(/_encrypted/.test(raw), 'stored blob should be an encryption envelope');
    assert.ok(!raw.includes('123456782'), 'plaintext PII must not appear in the stored blob');
    const got = await store.getMessages('nb2', 'u2', DEK);
    assert.strictEqual(got[0].content, 'BSN 123456782');
});

test('a session DEK alone does NOT encrypt when the org tier is `none`', async () => {
    // The old contract. An org that has never switched encryption on must not
    // silently get encrypted notebooks it cannot administer or turn off.
    rows.clear();
    encryptionOff();
    await store.appendMessages('nbP', 'uP', DEK, [{ role: 'user', content: 'plain' }]);
    const raw = _findByNbUser('nbP', 'uP').messages_json;
    assert.ok(!/_encrypted/.test(raw), 'tier `none` means plaintext, whoever is calling');
    assert.deepStrictEqual((await store.getMessages('nbP', 'uP', DEK)).map(m => m.content), ['plain']);
});

test('blobs written under the OLD always-on behaviour still open after the change', async () => {
    // Reads must never consult the policy: rows written when encryption was on
    // have to stay readable after it is switched off, or a toggle becomes a
    // data-loss event.
    rows.clear();
    encryptionOn();
    await store.appendMessages('nbL', 'uL', DEK, [{ role: 'user', content: 'legacy secret' }]);
    encryptionOff();
    const got = await store.getMessages('nbL', 'uL', DEK);
    assert.deepStrictEqual(got.map(m => m.content), ['legacy secret']);
});

test('a locked history is reported as locked, never as empty', async () => {
    // Returning [] here would let the append below overwrite still-recoverable
    // ciphertext with just the new turn — and store it in the clear.
    rows.clear();
    encryptionOn();
    await store.appendMessages('nbX', 'uX', DEK, [{ role: 'user', content: 'sealed' }]);

    const WRONG = Buffer.alloc(32, 9).toString('base64');
    notebookPolicy = { encryptNotebookMessages: true, key: Buffer.alloc(32, 9), backgroundKey: null, tier: 'zk' };
    const { messages, locked } = await store.getMessagesWithMeta('nbX', 'uX', WRONG);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(locked, true, 'the UI must be able to say "history unavailable"');

    await assert.rejects(
        () => store.appendMessages('nbX', 'uX', WRONG, [{ role: 'user', content: 'new turn' }]),
        (err) => err.code === 'HISTORY_LOCKED',
        'appending over an unopenable blob must be refused, not silently destructive',
    );
});

test('an encrypted-but-empty history is not mistaken for locked', async () => {
    rows.clear();
    encryptionOn();
    await store.replaceMessages('nbE', 'uE', DEK, []);
    const { messages, locked } = await store.getMessagesWithMeta('nbE', 'uE', DEK);
    assert.deepStrictEqual(messages, []);
    assert.strictEqual(locked, false);
});

test('append accumulates turns across calls', async () => {
    rows.clear();
    encryptionOn();
    await store.appendMessages('nb3', 'u3', DEK, [{ role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }]);
    await store.appendMessages('nb3', 'u3', DEK, [{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
    const got = await store.getMessages('nb3', 'u3', DEK);
    assert.deepStrictEqual(got.map(m => m.content), ['q1', 'a1', 'q2', 'a2']);
});

test('one row per (notebook,user) — concurrent first-writes do not duplicate', async () => {
    rows.clear();
    encryptionOn();
    await Promise.all([
        store.appendMessages('nb4', 'u4', DEK, [{ role: 'user', content: 'x' }]),
        store.appendMessages('nb4', 'u4', DEK, [{ role: 'user', content: 'y' }]),
    ]);
    const matching = [...rows.values()].filter(r => r.notebook_id === 'nb4' && r.user_id === 'u4');
    assert.strictEqual(matching.length, 1);
});

test('deleteForNotebook clears the conversation', async () => {
    rows.clear();
    encryptionOn();
    await store.appendMessages('nb5', 'u5', DEK, [{ role: 'user', content: 'z' }]);
    await store.deleteForNotebook('nb5', 'u5');
    const got = await store.getMessages('nb5', 'u5', DEK);
    assert.deepStrictEqual(got, []);
});

test('isolation: another user cannot read this user’s conversation', async () => {
    rows.clear();
    encryptionOn();
    await store.appendMessages('nb6', 'u6', DEK, [{ role: 'user', content: 'secret' }]);
    const other = await store.getMessages('nb6', 'someone-else', DEK);
    assert.deepStrictEqual(other, []);
});
