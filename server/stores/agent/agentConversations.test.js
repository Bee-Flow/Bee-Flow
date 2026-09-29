/**
 * Which key opens which column on the agent_conversations table.
 *
 * getConversation resolved ONE owner-derived context and handed it to
 * _readMessages as `sharedCtx`, which short-circuits that function's
 * crypto_scope branch. A conversation shared into a project therefore had its
 * PROJECT-key ciphertext opened with the OWNER's key: rowToMessage threw
 * FieldDecryptError, _readMessages deliberately rethrows FIELD_DECRYPT_FAILED
 * rather than falling back to the blob, and the whole request 500'd — including
 * GET /api/agents/:id/history for the conversation's own owner.
 *
 * The split the fix encodes, and what these tests pin:
 *
 *   messages   follow crypto_scope   (sharedConversations re-keys them)
 *   meta_json  follows crypto_scope  (sharedConversations re-keys it too)
 *   title      always the OWNER's escrow key — listConversations,
 *              listAllConversations and searchConversations each resolve one
 *              owner context for a whole page, so a title that changed key on
 *              sharing would render null in the owner's own list.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/agentConversations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const SERVER = path.join(__dirname, '..', '..');
const OWNER_ESCROW = crypto.createHash('sha256').update('agentconv-owner-escrow').digest();
const PROJECT_KEY = crypto.createHash('sha256').update('agentconv-project-p1').digest();

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = { id: absPath, filename: absPath, loaded: true, exports };
}

const rows = {};
const reads = [];            // { id, keyLabel } per convMessages.getMessages call

mockModule(path.join(SERVER, 'db'), {
    async exec() {},
    async getOne(sql, params) {
        if (!/FROM agent_conversations/i.test(sql)) return null;
        if (/agent_id = \$1/.test(sql)) {
            const r = Object.values(rows).find(x => x.agent_id === params[0] && x.user_id === params[1]);
            return r ? { ...r } : null;
        }
        const r = rows[params[0]];
        return r ? { ...r } : null;
    },
    async getAll() { return []; },
    async run(sql, params) {
        if (/SET meta_json = \$1 WHERE id = \$2/.test(sql)) { rows[params[1]].meta_json = params[0]; return { rowCount: 1 }; }
        if (/SET title = \$1 WHERE id = \$2/.test(sql)) { rows[params[1]].title = params[0]; return { rowCount: 1 }; }
        return { rowCount: 0 };
    },
    async getClient() { throw new Error('not used'); },
});

mockModule(path.join(SERVER, 'stores', 'agent', 'initSchema'), { async initDB() {} });
mockModule(path.join(SERVER, 'stores', 'agent', 'messageEncryption'), {
    encryptMessages: v => v, decryptMessages: v => v,
});
mockModule(path.join(SERVER, 'stores', 'agent', 'conversationMessages'), {
    async getMessages(id, ctx) { reads.push({ id, keyLabel: ctx && ctx.label }); return []; },
    async replaceMessages() {}, async appendMessages() {}, async migrateConversationIfNeeded() {},
});

const ON = { encryptMessages: true, encryptMeta: true, encryptConversationMeta: true, encryptTitle: true, tier: 'managed' };
const OWNER_CTX = { key: OWNER_ESCROW, backgroundKey: OWNER_ESCROW, label: 'owner', ...ON };
const PROJECT_CTX = { key: PROJECT_KEY, backgroundKey: PROJECT_KEY, label: 'project:p1', ...ON, sharedProject: true };

const realMessageCrypto = require(path.join(SERVER, 'stores', 'agent', 'messageCrypto'));
mockModule(path.join(SERVER, 'stores', 'agent', 'messageCrypto'), {
    ...realMessageCrypto,
    async resolveCrypto(opts = {}) { return opts.projectKeyFor ? PROJECT_CTX : OWNER_CTX; },
});

const store = require('./agentConversations');
const { sealTitle, openTitle } = require('./conversationTitle');

const TITLE = 'Redundancy shortlist';

function seed({ id = 'ac1', owner = 'alice', shared = false, ctx = OWNER_CTX } = {}) {
    for (const k of Object.keys(rows)) delete rows[k];
    reads.length = 0;
    rows[id] = {
        id, agent_id: 'ag1', user_id: owner,
        project_id: shared ? 'p1' : null,
        shared_scope: shared ? 'project' : 'private',
        crypto_scope: shared ? 'project' : 'user',
        messages_migrated: true, messages_json: '[]', meta_json: '{}',
        thread_titles_json: '{}', pii_token_map: null,
        title: sealTitle(TITLE, id, 'agent', ctx),
    };
    return id;
}

// ── messages follow crypto_scope ────────────────────────────────────────────

test('getConversation reads a project-shared thread with the PROJECT key', async () => {
    seed({ shared: true });
    await store.getConversation('ag1', 'alice');
    assert.deepStrictEqual(reads.map(r => r.keyLabel), ['project:p1'],
        'the hoisted owner ctx must not short-circuit _readMessages');
});

test('getConversation reads a private thread with the OWNER key', async () => {
    seed({ shared: false });
    await store.getConversation('ag1', 'alice');
    assert.deepStrictEqual(reads.map(r => r.keyLabel), ['owner']);
});

test('getConversationById agrees with getConversation on the same row', async () => {
    const id = seed({ shared: true });
    await store.getConversation('ag1', 'alice');
    await store.getConversationById(id);
    assert.deepStrictEqual(reads.map(r => r.keyLabel), ['project:p1', 'project:p1'],
        'the two read paths must never disagree about the key');
});

// ── title stays owner-keyed ─────────────────────────────────────────────────

test('a shared thread keeps its NAME for the owner', async () => {
    seed({ shared: true });
    const conv = await store.getConversation('ag1', 'alice');
    assert.strictEqual(conv.title, TITLE);
});

test('updateConversationTitle keeps writing under the owner key on a shared row', async () => {
    const id = seed({ shared: true });
    await store.updateConversationTitle(id, 'Renamed');
    assert.strictEqual(openTitle(rows[id].title, id, 'agent', OWNER_CTX), 'Renamed');
    assert.strictEqual(openTitle(rows[id].title, id, 'agent', PROJECT_CTX), null);
    const conv = await store.getConversation('ag1', 'alice');
    assert.strictEqual(conv.title, 'Renamed', 'and the read path agrees');
});

// ── meta_json follows crypto_scope ──────────────────────────────────────────

test('meta written on a shared thread is readable by every meta path', async () => {
    const id = seed({ shared: true });
    await store.updateConversationMeta(id, { conversationSummary: 'compacted précis' });

    const viaHelper = await store.getConversationMeta(id);
    assert.strictEqual(viaHelper.conversationSummary, 'compacted précis');

    const conv = await store.getConversation('ag1', 'alice');
    assert.strictEqual(conv.meta.conversationSummary, 'compacted précis');

    const byId = await store.getConversationById(id);
    assert.strictEqual(byId.meta.conversationSummary, 'compacted précis');
});

test('meta on a private thread still rides the owner escrow key', async () => {
    const id = seed({ shared: false });
    await store.updateConversationMeta(id, { conversationSummary: 'private précis' });
    const { decryptField } = require('../lib/fieldEnvelope');
    const aad = store._metaAad(id);
    assert.doesNotThrow(() => decryptField(rows[id].meta_json, {
        key: realMessageCrypto.conversationKey(OWNER_ESCROW, id), aad,
    }));
});

test('meta on a shared thread is sealed with the PROJECT key, matching crypto_scope', async () => {
    const id = seed({ shared: true });
    await store.updateConversationMeta(id, { conversationSummary: 'shared précis' });
    const { decryptField } = require('../lib/fieldEnvelope');
    const aad = store._metaAad(id);
    assert.doesNotThrow(() => decryptField(rows[id].meta_json, {
        key: realMessageCrypto.conversationKey(PROJECT_KEY, id), aad,
    }));
    assert.throws(() => decryptField(rows[id].meta_json, {
        key: realMessageCrypto.conversationKey(OWNER_ESCROW, id), aad,
    }));
});
