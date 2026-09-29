/**
 * `direct_conversations.knowledge_base_ids` — the storage half of C3.
 *
 * The store deliberately does NOT authorize (that needs a request), so what is
 * pinned here is the other half of the contract: it must never WIDEN what it
 * is handed, it must never let anything but the owner rewrite the list, and
 * the column must never be shadowable by caller-supplied state.
 *
 *   - `meta_json` is spread over the row in getDirectConversation, and a meta
 *     key of the same name would silently replace the column that says which
 *     knowledge bases this conversation may search. Restored from the column,
 *     last, always.
 *   - the write is `AND user_id = $n`: a project EDITOR may POST into a shared
 *     thread but may NOT repoint the owner's knowledge bases (the canManage
 *     line the workspace already draws).
 *   - a caller id is REQUIRED — a scoping parameter that degrades to "no
 *     scope" is not a scope.
 *   - the column lands on the first boot after a deploy, so every statement
 *     naming it survives the window before that, and the pre-migration failure
 *     is reported as itself rather than as "you are not the owner".
 *
 * Runs with NO database and NO network: db, the schema init and the crypto /
 * message plumbing are cut at their require seams (same approach as
 * directConversations.crypto.test.js), so the code under test is the real
 * directConversations module.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/directConversations.kb.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'test';

// ── Fixtures ────────────────────────────────────────────────────────────────

const convs = new Map();   // id -> direct_conversations row
/** Set to make every statement that names the column fail, as a pre-migration DB does. */
let columnMissing = false;

const MISSING = () => Object.assign(
    new Error('column "knowledge_base_ids" of relation "direct_conversations" does not exist'),
    { code: '42703' }
);

const dbStub = {
    async exec() {},
    async getOne(sql, params) {
        if (/FROM direct_conversations/i.test(sql)) {
            const row = convs.get(params[0]);
            if (!row) return null;
            if (/user_id = \$2/i.test(sql) && row.user_id !== params[1]) return null;
            return { ...row };
        }
        return null;
    },
    async getAll() { return []; },
    async run(sql, params) {
        if (columnMissing && /knowledge_base_ids/i.test(sql)) throw MISSING();

        if (/INSERT INTO direct_conversations/i.test(sql)) {
            const withKb = /knowledge_base_ids/i.test(sql);
            const row = {
                id: params[0], user_id: params[1], title: params[2], messages_json: '[]',
                model_tier: params[3], meta_json: '{}', messages_migrated: false,
            };
            if (withKb) row.knowledge_base_ids = JSON.parse(params[4]);
            convs.set(row.id, row);
            return { rowCount: 1 };
        }
        if (/UPDATE direct_conversations SET knowledge_base_ids/i.test(sql)) {
            // [json, id, userId]. The owner predicate is read out of the SQL
            // rather than assumed: if it is ever dropped from the statement
            // this stub stops scoping too, and the "somebody else cannot
            // repoint" test below goes red instead of passing on the strength
            // of a parameter the query no longer uses.
            const scoped = /AND user_id = \$3/i.test(sql);
            const row = convs.get(params[1]);
            if (!row) return { rowCount: 0 };
            if (scoped && row.user_id !== params[2]) return { rowCount: 0 };
            row.knowledge_base_ids = JSON.parse(params[0]);
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
    async getClient() { return { async query() { return { rowCount: 1 }; }, release() {} }; },
};

// ── SEAMS ───────────────────────────────────────────────────────────────────
// Injected by ABSOLUTE filename into require.cache: Module._load consults the
// cache by resolved filename, so this holds regardless of how the module under
// test writes its own require string.
function seam(absPath, exports) {
    const filename = require.resolve(absPath);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const HERE = __dirname;
const SERVER = path.join(HERE, '..', '..');

seam(path.join(SERVER, 'db.js'), dbStub);
// The schema init opens real connections; the column's DDL is covered by
// stores/lib/_ddl.integration.test.js, not here.
seam(path.join(HERE, 'initSchema.js'), { initDB: async () => {} });
// Crypto resolution reads escrow rows out of the DB. No key = plaintext
// passthrough everywhere, which is what this test wants: it is about ids.
seam(path.join(HERE, 'messageCrypto.js'), {
    resolveCrypto: async () => ({ key: null, backgroundKey: null, encryptTitle: false, encryptConversationMeta: false }),
    conversationKey: () => null,
});
seam(path.join(HERE, 'conversationMessages.js'), {
    getMessages: async () => [],
    replaceMessages: async () => {},
    appendMessages: async () => {},
    migrateConversationIfNeeded: async () => {},
});
seam(path.join(HERE, 'messageEncryption.js'), { decryptMessages: (m) => m });

const store = require('./directConversations');

function reset() {
    convs.clear();
    columnMissing = false;
}

/** A stored row, written the way the DB would have it (jsonb → hydrated array). */
function seedConversation(id, userId, kbIds, extra = {}) {
    convs.set(id, {
        id, user_id: userId, title: 'Chat', messages_json: '[]', meta_json: '{}',
        model_tier: 'fast', messages_migrated: true, knowledge_base_ids: kbIds, ...extra,
    });
}

// ═══ Create ═══════════════════════════════════════════════════════

test('a new conversation is born carrying the ids it was given', async () => {
    reset();
    const conv = await store.createDirectConversation('alice', 'fast', ['kb-1', 'kb-2']);
    assert.deepStrictEqual(conv.knowledgeBaseIds, ['kb-1', 'kb-2']);
    assert.deepStrictEqual(convs.get(conv.id).knowledge_base_ids, ['kb-1', 'kb-2']);
});

test('a new conversation with no ids stores an empty list, not null', async () => {
    reset();
    const conv = await store.createDirectConversation('alice');
    assert.deepStrictEqual(conv.knowledgeBaseIds, []);
    assert.deepStrictEqual(convs.get(conv.id).knowledge_base_ids, []);
});

test('create never widens: rubbish in the list is dropped, not passed through', async () => {
    reset();
    const conv = await store.createDirectConversation('alice', 'fast', ['kb-1', null, 42, '', '  kb-1  ', { id: 'kb-x' }]);
    assert.deepStrictEqual(conv.knowledgeBaseIds, ['kb-1']);
});

test('create on a pre-migration database still creates the chat, with no bases', async () => {
    reset();
    columnMissing = true;
    const conv = await store.createDirectConversation('alice', 'fast', ['kb-1']);
    assert.ok(conv.id, 'the conversation must still exist');
    // Reported honestly as empty rather than echoing back ids that were never stored.
    assert.deepStrictEqual(conv.knowledgeBaseIds, []);
    assert.strictEqual(convs.get(conv.id).knowledge_base_ids, undefined);
});

// ═══ Write: the owner, and only the owner ═════════════════════════

test('the owner may replace the list', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    assert.strictEqual(await store.setDirectConversationKnowledgeBases('c1', ['kb-2', 'kb-3'], 'alice'), true);
    assert.deepStrictEqual(convs.get('c1').knowledge_base_ids, ['kb-2', 'kb-3']);
});

test('somebody else cannot repoint the owner\'s knowledge bases', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    // Bob may well be a project editor on a shared thread — he can post, but
    // which bases it searches is the owner's call.
    assert.strictEqual(await store.setDirectConversationKnowledgeBases('c1', ['kb-evil'], 'bob'), false);
    assert.deepStrictEqual(convs.get('c1').knowledge_base_ids, ['kb-1'], 'the stored list must be untouched');
});

test('the write refuses to run unscoped', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    for (const bad of [undefined, null, '', 0]) {
        await assert.rejects(
            () => store.setDirectConversationKnowledgeBases('c1', ['kb-2'], bad),
            (err) => err.code === 'CALLER_USER_ID_REQUIRED',
            `caller id: ${JSON.stringify(bad)}`
        );
    }
    assert.deepStrictEqual(convs.get('c1').knowledge_base_ids, ['kb-1']);
});

test('an empty list is a real instruction: it clears the attachment', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1', 'kb-2']);
    assert.strictEqual(await store.setDirectConversationKnowledgeBases('c1', [], 'alice'), true);
    assert.deepStrictEqual(convs.get('c1').knowledge_base_ids, []);
});

test('an unreadable list stores nothing rather than passing itself through', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    for (const rubbish of [null, undefined, 'kb-1', { kb: 'kb-1' }, [null, 3, '']]) {
        await store.setDirectConversationKnowledgeBases('c1', rubbish, 'alice');
        assert.deepStrictEqual(convs.get('c1').knowledge_base_ids, [], `input: ${JSON.stringify(rubbish)}`);
        convs.get('c1').knowledge_base_ids = ['kb-1'];
    }
});

test('a pre-migration column is reported as itself, not as a permission failure', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    columnMissing = true;
    await assert.rejects(
        () => store.setDirectConversationKnowledgeBases('c1', ['kb-2'], 'alice'),
        (err) => err.code === 'KB_COLUMN_MISSING'
    );
});

// ═══ Read ═════════════════════════════════════════════════════════

test('the stored ids come back on the read', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1', 'kb-2']);
    const conv = await store.getDirectConversation('c1', 'alice');
    assert.deepStrictEqual(conv.knowledgeBaseIds, ['kb-1', 'kb-2']);
});

test('meta_json cannot shadow the column', async () => {
    reset();
    // meta_json is caller-supplied conversation state and is spread OVER the
    // row. A key of this name must not become the answer to "which knowledge
    // bases may this chat search".
    seedConversation('c1', 'alice', ['kb-1'], {
        meta_json: JSON.stringify({ knowledgeBaseIds: ['kb-smuggled'], knowledge_base_ids: ['kb-smuggled'] }),
    });
    const conv = await store.getDirectConversation('c1', 'alice');
    assert.deepStrictEqual(conv.knowledgeBaseIds, ['kb-1']);
});

test('a row from before the migration reads as no bases, not as undefined', async () => {
    reset();
    convs.set('c1', {
        id: 'c1', user_id: 'alice', title: 'Chat', messages_json: '[]', meta_json: '{}',
        model_tier: 'fast', messages_migrated: true, // no knowledge_base_ids at all
    });
    const conv = await store.getDirectConversation('c1', 'alice');
    assert.deepStrictEqual(conv.knowledgeBaseIds, []);
});

test('a column holding something that is not a list of ids reads as no bases', async () => {
    reset();
    for (const stored of [null, '{"not":"a list"}', 'garbage', 17, [null, 3, 'kb-ok']]) {
        seedConversation('c1', 'alice', stored);
        const conv = await store.getDirectConversation('c1', 'alice');
        assert.ok(Array.isArray(conv.knowledgeBaseIds), `input: ${JSON.stringify(stored)}`);
        for (const id of conv.knowledgeBaseIds) assert.strictEqual(typeof id, 'string');
    }
});

test('a stranger still cannot read the conversation at all', async () => {
    reset();
    seedConversation('c1', 'alice', ['kb-1']);
    assert.strictEqual(await store.getDirectConversation('c1', 'mallory'), null);
});
