/**
 * Direct-conversation encryption: the read path, the meta surface, and the
 * plaintext blob.
 *
 * Three bugs are pinned here, all of the same shape — a write path was
 * protected while something adjacent was not, so the org saw "encrypted" and
 * the data was readable anyway:
 *
 *   B1  getDirectConversation took no encryptionKey at all. Once writes started
 *       encrypting on `zk`, every read threw and the conversation 500'd.
 *   B2  messages_json kept a COMPLETE plaintext copy of every conversation
 *       beside the encrypted table, on every tier, forever.
 *   B5  meta_json — which carries the compaction summary — was bare JSON on
 *       this table while the agent table encrypted it, even though the policy
 *       listed the surface as implemented.
 *
 * Runs with NO database and NO network. Every DB-touching edge of the store is
 * cut at a require seam via testUtils/stubRequire; see the SEAMS block below
 * for why each one is there. The assertions themselves are untouched — they
 * exercise the real directConversations, conversationMessages, messageCrypto,
 * messageEncryption, conversationTitle and fieldEnvelope code.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const { installResolveStub } = require('../../testUtils/stubRequire');

const SERVER = path.join(__dirname, '..', '..');
const DEK = crypto.createHash('sha256').update('direct-conv-test-dek').digest();

// ── Fixtures ────────────────────────────────────────────────────────────────

const convs = new Map();      // id -> direct_conversations row
const messageRows = new Map(); // conversationId -> rows

const dbStub = {
    async exec() {},
    async getOne(sql, params) {
        if (/FROM direct_conversations/i.test(sql)) {
            const row = convs.get(params[0]);
            if (!row) return null;
            if (/user_id = \$2/i.test(sql) && row.user_id !== params[1]) return null;
            return { ...row };
        }
        if (/FROM conversation_messages/i.test(sql)) {
            const rows = messageRows.get(params[0]) || [];
            return rows[0] ? { ...rows[0] } : null;
        }
        return null;
    },
    async getAll(sql, params) {
        if (/FROM conversation_messages/i.test(sql)) return (messageRows.get(params[0]) || []).map(r => ({ ...r }));
        return [];
    },
    async run(sql, params) {
        if (/UPDATE direct_conversations/i.test(sql)) {
            // Locate the row by whichever trailing params carry the id.
            const row = [...convs.values()].find(c => params.includes(c.id));
            if (!row) return { rowCount: 0 };
            if (/SET messages_json = \$1, meta_json = \$2/i.test(sql)) { row.messages_json = params[0]; row.meta_json = params[1]; }
            else if (/SET meta_json = \$1/i.test(sql)) { row.meta_json = params[0]; }
            else if (/SET messages_json = \$1/i.test(sql)) { row.messages_json = params[0]; }
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
    async getClient() {
        return {
            async query(sql, params) {
                if (/DELETE FROM conversation_messages/i.test(sql)) messageRows.set(params[0], []);
                else if (/INSERT INTO conversation_messages/i.test(sql)) {
                    const list = messageRows.get(params[1]) || [];
                    for (let i = 0; i < params.length; i += 8) {
                        list.push({
                            id: params[i], conversation_id: params[i + 1], conversation_type: params[i + 2],
                            role: params[i + 3], content: params[i + 4], tool_name: params[i + 5],
                            meta_json: params[i + 6], seq: params[i + 7],
                        });
                    }
                    messageRows.set(params[1], list);
                }
                return { rowCount: 1 };
            },
            release() {},
        };
    },
};

// Tier is driven per test; the real messageCrypto is kept for conversationKey()
// and messageAad(), only the tier lookup (which reads escrow rows out of the DB)
// is replaced.
let ctx = null;
// Required by ABSOLUTE path on purpose. Node's Module._load consults its
// relativeResolveCache (keyed by `parent.path + "\0" + request`) BEFORE it
// calls the patched _resolveFilename, and this file sits in the same directory
// as directConversations.js — so a `require('./messageCrypto')` here would
// cache the REAL filename under the very key the stub needs, and every later
// './messageCrypto' in this directory would silently skip the stub and run the
// real resolveCrypto (→ ECONNREFUSED 127.0.0.1:5432).
const realMessageCrypto = require(path.join(SERVER, 'stores', 'agent', 'messageCrypto'));

// ── SEAMS ───────────────────────────────────────────────────────────────────
// installResolveStub matches the require string EXACTLY AS WRITTEN IN THE
// MODULE BEING STUBBED OUT, not relative to this file. A key that stops
// matching is ignored in silence and the real module loads instead, so each
// key below names its source line:
//
//   '../../db'                          directConversations.js:10,
//                                       conversationMessages.js:38
//                                       (also encryptionPolicy.js:185, lazy)
//   './initSchema'                      directConversations.js:11
//   './messageCrypto'                   directConversations.js:14,
//                                       conversationMessages.js:40,
//                                       conversationTitle.js:26
//   '../../auth/decryptAudit'           messageEncryption.js:7
//   '../../core/privacy/piiDetection'   directConversations.js:224 (lazy)
//
// The last two are the ones that made this file un-runnable rather than merely
// red:
//   * decryptAudit installs a 5-minute setInterval at module load and never
//     unrefs it, so the process could not exit and node --test killed the whole
//     file on the timeout AFTER all 13 assertions had already passed.
//   * piiDetection pulls in stores/configStore, a DB-backed singleton that
//     self-initialises on require ("[ConfigStore] Initialized (PostgreSQL)")
//     and opens a LISTEN/NOTIFY pg Client outside NODE_ENV=test.
const restoreStubs = installResolveStub({
    '../../db': dbStub,
    './initSchema': { async initDB() {} },
    './messageCrypto': {
        ...realMessageCrypto,
        async resolveCrypto() { return ctx; },
    },
    '../../auth/decryptAudit': {
        trackDecrypt() {},
        getDecryptStats() { return null; },
    },
    '../../core/privacy/piiDetection': {
        // Reached only from the UI read path, and only for messages that carry
        // a tokenMap — no fixture here does, so this exact-key replacement
        // stands in for the real drift-tolerant matcher without touching any
        // assertion below.
        restoreTokens(text, tokenMap) {
            if (!tokenMap || !text) return text;
            const keys = Object.keys(tokenMap).sort((a, b) => b.length - a.length);
            if (keys.length === 0) return text;
            const re = new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
            return String(text).replace(re, m => tokenMap[m]);
        },
    },
});

test.after(() => restoreStubs());

const store = require('./directConversations');
const { isEnvelope } = require('../lib/fieldEnvelope');

// Tripwire for the silent-miss failure mode: if a seam key ever drifts out of
// sync with the source, the real db.js loads instead — it builds a pg Pool and
// an ioredis client at module load — and this file goes back to needing a
// database. Fail here with the reason rather than 20s later on a socket.
assert.ok(
    !require.cache[require.resolve(path.join(SERVER, 'db.js'))],
    'the real server/db.js was loaded: a stub key above no longer matches the '
    + 'require string written in the module under test',
);

const PLAIN = { key: null, backgroundKey: null, encryptMessages: false, encryptMeta: false, encryptConversationMeta: false, encryptTitle: false, tier: 'none' };
const ZK_SESSION = { key: DEK, backgroundKey: crypto.createHash('sha256').update('escrow').digest(), encryptMessages: true, encryptMeta: true, encryptConversationMeta: true, encryptTitle: true, tier: 'zk' };
const ZK_NO_SESSION = { ...ZK_SESSION, key: null, encryptMessages: false, encryptMeta: false };

function seed(id = 'c1', userId = 'u1', { migrated = true } = {}) {
    convs.clear(); messageRows.clear();
    convs.set(id, {
        id, user_id: userId, title: 'Chat', meta_json: '{}',
        messages_json: '[]', messages_migrated: migrated, pii_token_map: null, model_tier: 'fast',
    });
}

const MESSAGES = [{ role: 'user', content: 'What is our Q3 severance exposure?' }];

// ── B1: the read path ───────────────────────────────────────────────────────

test('a conversation written with a session key reads back with that key', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', null, { encryptionKey: DEK });

    const stored = messageRows.get('c1')[0];
    assert.ok(isEnvelope(stored.content), 'content must be ciphertext on disk');

    const conv = await store.getDirectConversation('c1', 'u1', { encryptionKey: DEK });
    assert.strictEqual(conv.messages[0].content, MESSAGES[0].content);
});

test('the same conversation THROWS rather than silently returning nothing without the key', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', null, { encryptionKey: DEK });

    // This is the shape of the bug: the route used to call with no key at all.
    // Throwing is correct — an empty message list would look like a lost chat
    // and would be overwritten on the next turn.
    ctx = ZK_NO_SESSION;
    await assert.rejects(
        () => store.getDirectConversation('c1', 'u1', {}),
        (err) => err.code === 'FIELD_DECRYPT_FAILED',
    );
});

test('plaintext conversations still read after encryption is switched on', async () => {
    seed();
    ctx = PLAIN;
    await store.updateDirectConversation('c1', MESSAGES, 'u1');
    ctx = ZK_SESSION;
    const conv = await store.getDirectConversation('c1', 'u1', { encryptionKey: DEK });
    assert.strictEqual(conv.messages[0].content, MESSAGES[0].content,
        'reads are format-driven, never mode-driven');
});

// ── B2: the plaintext blob ──────────────────────────────────────────────────

test('a migrated conversation no longer writes the plaintext blob', async () => {
    seed('c1', 'u1', { migrated: true });
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', null, { encryptionKey: DEK });

    const blob = convs.get('c1').messages_json;
    assert.strictEqual(blob, '[]', 'the blob is dead weight once migrated — and it leaked everything');
    assert.ok(!String(blob).includes('severance'));
});

test('an UNMIGRATED conversation still writes the blob (rollback safety intact)', async () => {
    seed('c1', 'u1', { migrated: false });
    ctx = PLAIN;
    await store.updateDirectConversation('c1', MESSAGES, 'u1');
    assert.ok(convs.get('c1').messages_json.includes('severance'),
        'rows the new table does not cover yet must keep their copy');
});

test('the blob is not written even when meta is being merged', async () => {
    seed('c1', 'u1', { migrated: true });
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', { activatedSkillIds: ['s1'] }, { encryptionKey: DEK });
    assert.strictEqual(convs.get('c1').messages_json, '[]');
});

// ── B5: conversation meta ───────────────────────────────────────────────────

test('meta_json is encrypted and round-trips', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversationMeta('c1', 'u1', { conversationSummary: 'Board discussed redundancies' });

    assert.ok(isEnvelope(convs.get('c1').meta_json), 'the compaction summary is conversation content');
    assert.ok(!convs.get('c1').meta_json.includes('redundancies'));

    const meta = await store.getDirectConversationMeta('c1', 'u1');
    assert.strictEqual(meta.conversationSummary, 'Board discussed redundancies');
});

test('meta merges do not lose existing keys', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversationMeta('c1', 'u1', { a: 1 });
    await store.updateDirectConversationMeta('c1', 'u1', { b: 2 });
    const meta = await store.getDirectConversationMeta('c1', 'u1');
    assert.deepStrictEqual(meta, { a: 1, b: 2 });
});

test('meta written while encryption was on still reads after it is switched off', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversationMeta('c1', 'u1', { conversationSummary: 'kept' });
    const encrypted = convs.get('c1').meta_json;

    // Switching the tier off must not strand what is already stored — the read
    // has the escrow key regardless of what the policy now says.
    ctx = { ...ZK_SESSION, encryptConversationMeta: false };
    const meta = await store.getDirectConversationMeta('c1', 'u1');
    assert.strictEqual(meta.conversationSummary, 'kept');
    assert.ok(isEnvelope(encrypted));
});

test('meta uses the ESCROW key, so a keyless caller can still read it', async () => {
    // Compaction runs from the runtime with no session. On zk that is the whole
    // reason conversation meta rides on backgroundKey rather than the session DEK.
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversationMeta('c1', 'u1', { conversationSummary: 'nightly précis' });

    ctx = ZK_NO_SESSION;
    const meta = await store.getDirectConversationMeta('c1', 'u1');
    assert.strictEqual(meta.conversationSummary, 'nightly précis');
});

// ── B9: refuse a silent downgrade ───────────────────────────────────────────
// replaceMessages is a full DELETE + re-INSERT, so a keyless context does not
// merely skip encrypting the new turn — it rewrites the WHOLE conversation in
// the clear, in one statement, with nothing in the logs.

test('a keyless write over an encrypted conversation is REFUSED, not silently applied', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', null, { encryptionKey: DEK });
    const before = messageRows.get('c1').map(r => r.content);

    const convMessages = require('./conversationMessages');
    await assert.rejects(
        () => convMessages.replaceMessages('c1', 'direct', [{ role: 'user', content: 'oops' }], ZK_NO_SESSION),
        (err) => err.code === 'ENCRYPTION_DOWNGRADE_REFUSED',
    );
    assert.deepStrictEqual(messageRows.get('c1').map(r => r.content), before,
        'the ciphertext must be untouched after the refusal');
});

test('turning encryption OFF is an allowed downgrade — the operator asked for it', async () => {
    seed();
    ctx = ZK_SESSION;
    await store.updateDirectConversation('c1', MESSAGES, 'u1', null, { encryptionKey: DEK });

    const convMessages = require('./conversationMessages');
    await convMessages.replaceMessages('c1', 'direct', [{ role: 'user', content: 'now plaintext' }], PLAIN);
    assert.strictEqual(messageRows.get('c1')[0].content, 'now plaintext');
});

test('a plaintext conversation is not affected by the guard', async () => {
    seed();
    ctx = PLAIN;
    await store.updateDirectConversation('c1', MESSAGES, 'u1');
    const convMessages = require('./conversationMessages');
    await convMessages.replaceMessages('c1', 'direct', [{ role: 'user', content: 'still fine' }], ZK_NO_SESSION);
    assert.strictEqual(messageRows.get('c1')[0].content, 'still fine');
});
