/**
 * Sharing a conversation into a project: which columns change key, and which
 * must not.
 *
 * `crypto_scope` is supposed to be an honest description of what is on disk.
 * Sharing flipped it to 'project' but re-keyed ONLY conversation_messages, so:
 *
 *   1. meta_json (compaction summary, activated skills) stayed sealed under the
 *      OWNER's key while every reader now derived the PROJECT key.
 *      getDirectConversation threw FieldDecryptError straight out into an HTTP
 *      500 — for the owner and for every project member.
 *   2. The title has the opposite problem: it is owner-keyed by EVERY writer
 *      (createDirectConversation, updateDirectConversationTitle) and read by
 *      per-user list endpoints that resolve one owner context per page, so it
 *      must NOT move to the project key. The read path had drifted anyway, and
 *      openTitle swallowed the failure, so shared threads lost their name.
 *   3. listProjectThreads handed the raw {"_bfenc":1,...} envelope back to the
 *      project Threads tab, which rendered it as the thread's name — the
 *      `|| untitled` fallback never fires, a ciphertext string being truthy.
 *
 * Real fieldEnvelope + conversationTitle crypto; only key RESOLUTION is stubbed.
 *
 * Run: cd server && node --test --test-force-exit stores/agent/sharedConversations.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';

const SERVER = path.join(__dirname, '..', '..');
const OWNER_ESCROW = crypto.createHash('sha256').update('shared-test-owner-escrow').digest();
const PROJECT_KEY = crypto.createHash('sha256').update('shared-test-project-p1').digest();

function mockModule(absPath, exports) {
    require.cache[require.resolve(absPath)] = { id: absPath, filename: absPath, loaded: true, exports };
}

const rows = {};                 // id -> conversation row (either table)
const resolveCalls = [];

mockModule(path.join(SERVER, 'db'), {
    async exec() {},
    async getOne(sql, params) {
        if (!/FROM (direct_conversations|agent_conversations)/i.test(sql)) return null;
        const r = rows[params[0]];
        if (!r) return null;
        if (/user_id = \$2/.test(sql) && r.user_id !== params[1]) return null;
        if (/shared_scope = 'project'/.test(sql) && r.shared_scope !== 'project') return null;
        return { ...r };
    },
    async getAll(sql, params) {
        if (/project_id = \$1/.test(sql)) {
            return Object.values(rows)
                .filter(r => r.project_id === params[0] && r.shared_scope === 'project')
                .map(r => ({ ...r, conv_type: r._type || 'direct' }));
        }
        return [];
    },
    async run(sql, params) {
        if (/SET meta_json = \$1 WHERE id = \$2/.test(sql)) { rows[params[1]].meta_json = params[0]; return { rowCount: 1 }; }
        if (/SET meta_json = \$1, updated_at/.test(sql)) { rows[params[1]].meta_json = params[0]; return { rowCount: 1 }; }
        if (/SET meta_json = \$1 WHERE id = \$2 AND user_id = \$3/.test(sql)) { rows[params[1]].meta_json = params[0]; return { rowCount: 1 }; }
        if (/SET project_id = \$1/.test(sql)) {
            const r = rows[params[2]];
            if (!r || r.user_id !== params[3]) return { rowCount: 0 };
            r.project_id = params[0]; r.shared_scope = 'project'; r.crypto_scope = params[1];
            return { rowCount: 1 };
        }
        if (/SET shared_scope = 'private'/.test(sql)) {
            const r = rows[params[0]];
            if (!r || r.user_id !== params[1]) return { rowCount: 0 };
            r.shared_scope = 'private'; r.crypto_scope = 'user'; // project_id intentionally left as-is
            return { rowCount: 1 };
        }
        return { rowCount: 0 };
    },
    async getClient() { throw new Error('not used'); },
});

mockModule(path.join(SERVER, 'stores', 'agent', 'initSchema'), { async initDB() {} });
mockModule(path.join(SERVER, 'stores', 'agent', 'messageEncryption'), {
    encryptMessages: v => v, decryptMessages: v => v,
});
mockModule(path.join(SERVER, 'stores', 'agent', 'conversationMessages'), {
    async getMessages() { return []; },
    async replaceMessages() {}, async appendMessages() {}, async migrateConversationIfNeeded() {},
    async rekeyConversation() { return 1; },
});
mockModule(path.join(SERVER, 'auth', 'projectAccess'), { hasProjectRole: async () => true });

// Managed tier: backgroundKey === key. Only key RESOLUTION is stubbed — every
// seal/open below runs the real fieldEnvelope + conversationTitle code.
const ON = { encryptMessages: true, encryptMeta: true, encryptConversationMeta: true, encryptTitle: true, tier: 'managed' };
const OWNER_CTX = { key: OWNER_ESCROW, backgroundKey: OWNER_ESCROW, ...ON };
const PROJECT_CTX = { key: PROJECT_KEY, backgroundKey: PROJECT_KEY, ...ON, sharedProject: true };
const PLAIN_CTX = { key: null, backgroundKey: null, encryptMessages: false, encryptMeta: false, encryptConversationMeta: false, encryptTitle: false, tier: 'none' };

let plaintextOrg = false;
const realMessageCrypto = require(path.join(SERVER, 'stores', 'agent', 'messageCrypto'));
mockModule(path.join(SERVER, 'stores', 'agent', 'messageCrypto'), {
    ...realMessageCrypto,
    async resolveCrypto(opts = {}) {
        resolveCalls.push(opts);
        if (plaintextOrg) return PLAIN_CTX;
        return opts.projectKeyFor ? PROJECT_CTX : OWNER_CTX;
    },
});

const direct = require('./directConversations');
const shared = require('./sharedConversations');
const { sealTitle, openTitle } = require('./conversationTitle');
const { isEnvelope } = require('../lib/fieldEnvelope');

const TITLE = 'Q3 severance planning';
const SUMMARY = 'Board discussed redundancy figures.';

function seed({ id = 'c1', owner = 'alice', type = 'direct', ctx = OWNER_CTX } = {}) {
    rows[id] = {
        id, user_id: owner, _type: type,
        project_id: null, shared_scope: 'private', crypto_scope: 'user',
        messages_migrated: true, messages_json: '[]', pii_token_map: null,
        title: sealTitle(TITLE, id, type, ctx),
        meta_json: '{}',
    };
    return id;
}

function reset() {
    for (const k of Object.keys(rows)) delete rows[k];
    resolveCalls.length = 0;
    plaintextOrg = false;
}

async function share(id = 'c1', owner = 'alice') {
    return shared.shareConversationToProject({
        conversationId: id, type: 'direct', projectId: 'p1', ownerId: owner, orgId: 'org1',
    });
}

// ── The 500 ─────────────────────────────────────────────────────────────────

test('a shared thread with meta still opens — for its owner', async () => {
    reset(); seed();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    assert.ok(isEnvelope(rows.c1.meta_json), 'precondition: the summary is sealed on disk');

    await share();
    assert.strictEqual(rows.c1.crypto_scope, 'project');

    const conv = await direct.getDirectConversation('c1', 'alice');
    assert.strictEqual(conv.meta.conversationSummary, SUMMARY);
    assert.strictEqual(conv.title, TITLE);
});

test('...and for a project member who is not the owner', async () => {
    reset(); seed();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    await share();

    const conv = await direct.getDirectConversation('c1', 'bob');
    assert.strictEqual(conv.meta.conversationSummary, SUMMARY);
    assert.strictEqual(conv.title, TITLE);
});

test('meta_json is actually MOVED to the project key, not left owner-keyed', async () => {
    reset(); seed();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    await share();

    // crypto_scope claims 'project'; the bytes on disk must agree with it.
    const { decryptField } = require('../lib/fieldEnvelope');
    const { conversationKey } = realMessageCrypto;
    const aad = direct._directMetaAad('c1');
    assert.doesNotThrow(
        () => decryptField(rows.c1.meta_json, { key: conversationKey(PROJECT_KEY, 'c1'), aad }),
        'the project key must open it',
    );
    assert.throws(
        () => decryptField(rows.c1.meta_json, { key: conversationKey(OWNER_ESCROW, 'c1'), aad }),
        'the owner key must no longer open it',
    );
});

test('the TITLE stays on the owner key — the per-user lists depend on it', async () => {
    reset(); seed();
    await share();
    assert.strictEqual(openTitle(rows.c1.title, 'c1', 'direct', OWNER_CTX), TITLE,
        'listDirectConversations resolves the owner context for the whole page');
    assert.strictEqual(openTitle(rows.c1.title, 'c1', 'direct', PROJECT_CTX), null,
        'and it was never sealed with the project key by any writer');
});

test('the meta helpers agree with getDirectConversation on a shared thread', async () => {
    reset(); seed();
    await share();
    // A shared-thread meta write must land where the conversation read looks.
    await direct.updateDirectConversationMeta('c1', 'alice', { activatedSkillIds: ['s1'] });
    const conv = await direct.getDirectConversation('c1', 'alice');
    assert.deepStrictEqual(conv.meta.activatedSkillIds, ['s1']);
    const meta = await direct.getDirectConversationMeta('c1', 'alice');
    assert.deepStrictEqual(meta.activatedSkillIds, ['s1']);
});

// ── Unshare is the mirror image ─────────────────────────────────────────────

test('unsharing brings meta_json back to the owner key', async () => {
    reset(); seed();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    await share();
    await shared.unshareConversation({ conversationId: 'c1', type: 'direct', ownerId: 'alice', orgId: 'org1' });

    assert.strictEqual(rows.c1.crypto_scope, 'user');
    const conv = await direct.getDirectConversation('c1', 'alice');
    assert.strictEqual(conv.meta.conversationSummary, SUMMARY);
    assert.strictEqual(conv.title, TITLE);
});

test('a share/unshare round trip is lossless', async () => {
    reset(); seed();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY, activatedSkillIds: ['s1'] });
    for (let i = 0; i < 3; i++) {
        await share();
        await shared.unshareConversation({ conversationId: 'c1', type: 'direct', ownerId: 'alice', orgId: 'org1' });
    }
    const meta = await direct.getDirectConversationMeta('c1', 'alice');
    assert.deepStrictEqual(meta, { conversationSummary: SUMMARY, activatedSkillIds: ['s1'] });
});

// ── listProjectThreads ──────────────────────────────────────────────────────

test('the project Threads tab gets a NAME, not a ciphertext envelope', async () => {
    reset(); seed();
    await share();

    const threads = await shared.listProjectThreads('p1');
    assert.strictEqual(threads.length, 1);
    assert.strictEqual(threads[0].title, TITLE);
    assert.ok(!String(threads[0].title).includes('_bfenc'));
});

test('one key resolution per OWNER, not per row', async () => {
    reset();
    seed({ id: 'a1', owner: 'alice' });
    seed({ id: 'a2', owner: 'alice' });
    seed({ id: 'b1', owner: 'bob' });
    for (const id of ['a1', 'a2', 'b1']) await share(id, id.startsWith('a') ? 'alice' : 'bob');

    resolveCalls.length = 0;
    const threads = await shared.listProjectThreads('p1');
    assert.strictEqual(threads.length, 3);
    for (const t of threads) assert.strictEqual(t.title, TITLE);
    assert.strictEqual(resolveCalls.length, 2, 'alice + bob, not one per row');
});

test('a plaintext title passes through untouched (no key resolved at all)', async () => {
    reset();
    plaintextOrg = true;
    seed({ ctx: PLAIN_CTX });
    await share();

    resolveCalls.length = 0;
    const threads = await shared.listProjectThreads('p1');
    assert.strictEqual(threads[0].title, TITLE);
    assert.strictEqual(resolveCalls.length, 0, 'nothing to open, nothing to resolve');
});

// ── Encryption off entirely ─────────────────────────────────────────────────

test('an org on tier `none` is untouched by any of this', async () => {
    reset();
    plaintextOrg = true;
    seed({ ctx: PLAIN_CTX });
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    assert.ok(!isEnvelope(rows.c1.meta_json));

    await share();
    assert.strictEqual(rows.c1.crypto_scope, 'user', 'nothing was encrypted, so nothing moved key');
    const conv = await direct.getDirectConversation('c1', 'alice');
    assert.strictEqual(conv.meta.conversationSummary, SUMMARY);
    assert.strictEqual(conv.title, TITLE);
});

// ── Damage already on disk ──────────────────────────────────────────────────

test('meta already sealed under the TARGET key is left alone, not destroyed', async () => {
    // The rows this bug produced: crypto_scope flipped, meta written afterwards
    // under the project key. Unsharing must not blank them.
    reset(); seed();
    await share();
    await direct.updateDirectConversationMeta('c1', 'alice', { conversationSummary: SUMMARY });
    const sealedUnderProject = rows.c1.meta_json;

    // Simulate a second unshare attempt over already-owner-keyed meta.
    await shared.unshareConversation({ conversationId: 'c1', type: 'direct', ownerId: 'alice', orgId: 'org1' });
    assert.notStrictEqual(rows.c1.meta_json, sealedUnderProject, 'it was converted once');
    const first = await direct.getDirectConversationMeta('c1', 'alice');
    assert.strictEqual(first.conversationSummary, SUMMARY);

    // Now the state the OLD code left behind: the row says 'project' but the
    // bytes are owner-keyed. Converting again must be a no-op, not a wipe.
    rows.c1.shared_scope = 'project';
    rows.c1.crypto_scope = 'project';
    await shared.unshareConversation({ conversationId: 'c1', type: 'direct', ownerId: 'alice', orgId: 'org1' });
    const meta = await direct.getDirectConversationMeta('c1', 'alice');
    assert.strictEqual(meta.conversationSummary, SUMMARY, 'a no-op conversion must not wipe the summary');
});
