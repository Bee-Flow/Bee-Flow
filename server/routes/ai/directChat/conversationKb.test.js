/**
 * Attaching knowledge bases to a direct conversation — the router's half.
 *
 * Two rules, and they pull in opposite directions on purpose:
 *
 *   WRITING is a read grant, so it fails LOUD. From the moment an id is stored
 *   the turn searches it with no further question, and core/localKBIngest does
 *   no tenant filtering of its own — the id list IS its access boundary. An id
 *   the caller may not use is a 400 naming it, exactly as the project linker
 *   answers (routes/projects.js). Quietly saving four of five would leave the
 *   picker showing a fifth the server refused.
 *
 *   READING fails QUIET, and re-checks. Being stored is not a permission: a
 *   base can be unpublished, pulled out of a group, switched off for chat or
 *   deleted after it was attached. So the read runs the same check again and
 *   hands back only what survives — the client is never told a base it may no
 *   longer use is still attached, and never told one was dropped either.
 *
 * Run: cd server && node --test --test-force-exit routes/ai/directChat/conversationKb.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

process.env.NODE_ENV = 'test';

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    conversations: {},   // id -> what getDirectConversation returns
    usable: [],          // what usableKbIdsForRequest says the caller may use
    usableThrows: false,
    writes: [],          // every setDirectConversationKnowledgeBases call
    writeResult: true,   // false = the owner-scoped UPDATE matched no row
    writeThrows: null,
};

const MOCKS = {
    '../../../stores/agentStore': {
        getDirectConversation: async (id, userId) => {
            const conv = fx.conversations[id];
            if (!conv) return null;
            // Mirrors the store: the owner path, plus project viewers of a
            // shared thread (which is why the write below is scoped again).
            if (conv.user_id !== userId && !conv.sharedViewers?.includes(userId)) return null;
            return { ...conv };
        },
        setDirectConversationKnowledgeBases: async (id, ids, userId) => {
            fx.writes.push({ id, ids, userId });
            if (fx.writeThrows) throw fx.writeThrows;
            return fx.writeResult;
        },
        updateDirectConversationTitle: async () => true,
        pinDirectConversation: async () => true,
        setDirectConversationLabels: async () => true,
        listDirectConversations: async () => [],
        deleteDirectConversation: async () => true,
        updateDirectConversation: async () => true,
        updateDirectConversationWorkspace: async () => true,
        listLabels: async () => [], createLabel: async () => ({}), updateLabel: async () => true, deleteLabel: async () => true,
    },
    '../../../support/kbAccess': {
        usableKbIdsForRequest: async (req, ids) => {
            if (fx.usableThrows) throw new Error('policy unavailable');
            return (Array.isArray(ids) ? ids : []).filter(id => fx.usable.includes(id));
        },
    },
    '../../../auth/permissions': {
        requireAuth: (req, res, next) => (req.session?.user?.id ? next() : res.status(401).json({ error: 'Not authenticated' })),
    },
    './shared': { encryptionOpts: () => ({}) },
    '../../../stores/configStore': { getConfig: async () => null },
    '../../../core/aiAgent': { getProviderForModel: async () => ({}) },
    '../../../core/providers': { getAdapter: () => ({}) },
    '../../../core/tools/sessionSkillRuntime': { bootstrapSessionSkills: async () => [] },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:direct-conv-kb:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /directChat[\\/]conversationRoutes\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./conversationRoutes');

test.after(() => { Module._resolveFilename = originalResolve; });

function reset() {
    fx.conversations = {
        c1: { id: 'c1', user_id: 'alice', title: 'Chat', knowledgeBaseIds: [], knowledge_base_ids: [], meta: {} },
    };
    fx.usable = [];
    fx.usableThrows = false;
    fx.writes.length = 0;
    fx.writeResult = true;
    fx.writeThrows = null;
}

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body, headers: {}, session, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => {
            // The refusals the schema raises travel as errors to the terminal
            // handler, so the harness has to be an app with one — without it a
            // 400 reads as a crashed test rather than as the answer.
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            const status = Number(err.status || err.statusCode) || 500;
            if (status >= 500) return reject(err);
            return res.status(status).json({ error: err.message, code: err.code, details: err.details });
        });
    });
}

const ALICE = { user: { id: 'alice' } };
const BOB = { user: { id: 'bob' } };

// ═══ Writing: a claim the caller cannot back is a 400 ═════════════

test('an id the caller may not use is refused, and named', async () => {
    reset();
    fx.usable = ['kb-ok'];
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-ok', 'kb-secret'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.invalid, ['kb-secret']);
    assert.deepStrictEqual(fx.writes, [], 'nothing may be stored when part of the list is refused');
});

test('a guessed id that resolves to nothing is refused like any other', async () => {
    reset();
    fx.usable = [];
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-does-not-exist'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(res.body.invalid, ['kb-does-not-exist']);
    assert.deepStrictEqual(fx.writes, []);
});

test('a check that cannot be run stores nothing — it is not a grant', async () => {
    reset();
    fx.usableThrows = true;
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-ok'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 500);
    assert.deepStrictEqual(fx.writes, []);
});

test('ids the caller may use are stored, and echoed back', async () => {
    reset();
    fx.usable = ['kb-a', 'kb-b'];
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-a', 'kb-b'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.knowledgeBaseIds, ['kb-a', 'kb-b']);
    assert.deepStrictEqual(fx.writes, [{ id: 'c1', ids: ['kb-a', 'kb-b'], userId: 'alice' }]);
});

test('an empty list detaches, and is not confused with "not provided"', async () => {
    reset();
    fx.usable = ['kb-a'];
    const cleared = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1', body: { knowledgeBaseIds: [] }, session: ALICE,
    });
    assert.strictEqual(cleared.statusCode, 200);
    assert.deepStrictEqual(fx.writes, [{ id: 'c1', ids: [], userId: 'alice' }]);

    // A rename must not touch the attachment at all.
    fx.writes.length = 0;
    const renamed = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1', body: { title: 'New name' }, session: ALICE,
    });
    assert.strictEqual(renamed.statusCode, 200);
    assert.deepStrictEqual(fx.writes, [], 'omitting the key must leave the stored list alone');
});

test('malformed input is refused rather than silently normalised away', async () => {
    reset();
    fx.usable = ['kb-a'];
    for (const body of [
        { knowledgeBaseIds: 'kb-a' },
        { knowledgeBaseIds: { id: 'kb-a' } },
        { knowledgeBaseIds: ['kb-a', null] },
        { knowledgeBaseIds: ['kb-a', ''] },
        { knowledgeBaseIds: ['kb-a', 42] },
        { knowledgeBaseIds: Array.from({ length: 51 }, (_, i) => `kb-${i}`) },
    ]) {
        const res = await dispatch({ method: 'PATCH', url: '/direct/conversations/c1', body, session: ALICE });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(fx.writes, []);
});

test('a project viewer of a shared thread cannot attach anything', async () => {
    reset();
    fx.conversations.c1.sharedViewers = ['bob'];
    fx.usable = ['kb-a'];
    // Bob passes the read gate (shared thread) but the store's owner-scoped
    // UPDATE matches no row. Answering `{success:true}` there would leave his
    // picker showing a selection the database never took.
    fx.writeResult = false;
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-a'] }, session: BOB,
    });
    assert.strictEqual(res.statusCode, 403);
});

test('a database that has not migrated says so, instead of blaming the user', async () => {
    reset();
    fx.usable = ['kb-a'];
    fx.writeThrows = Object.assign(new Error('not migrated'), { code: 'KB_COLUMN_MISSING' });
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-a'] }, session: ALICE,
    });
    assert.strictEqual(res.statusCode, 503);
});

test('a stranger gets 404 before any of this is reached', async () => {
    reset();
    fx.usable = ['kb-a'];
    const res = await dispatch({
        method: 'PATCH', url: '/direct/conversations/c1',
        body: { knowledgeBaseIds: ['kb-a'] }, session: { user: { id: 'mallory' } },
    });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(fx.writes, []);
});

// ═══ Reading: checked again, every time ═══════════════════════════

test('a base that lost its visibility disappears from the read', async () => {
    reset();
    fx.conversations.c1.knowledgeBaseIds = ['kb-a', 'kb-gone'];
    fx.conversations.c1.knowledge_base_ids = ['kb-a', 'kb-gone'];
    // kb-gone was authorised when it was attached; it is not any more.
    fx.usable = ['kb-a'];
    const res = await dispatch({ method: 'GET', url: '/direct/conversations/c1', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.knowledgeBaseIds, ['kb-a']);
});

test('the unfiltered column never rides along beside the filtered answer', async () => {
    reset();
    fx.conversations.c1.knowledgeBaseIds = ['kb-a', 'kb-gone'];
    fx.conversations.c1.knowledge_base_ids = ['kb-a', 'kb-gone'];
    fx.usable = ['kb-a'];
    const res = await dispatch({ method: 'GET', url: '/direct/conversations/c1', session: ALICE });
    assert.ok(!('knowledge_base_ids' in res.body), 'the raw column must not be shipped');
    assert.ok(!JSON.stringify(res.body).includes('kb-gone'), 'a dropped base must appear nowhere in the payload');
});

test('when the check cannot be run the read shows no bases at all', async () => {
    reset();
    fx.conversations.c1.knowledgeBaseIds = ['kb-a'];
    fx.conversations.c1.knowledge_base_ids = ['kb-a'];
    fx.usableThrows = true;
    const res = await dispatch({ method: 'GET', url: '/direct/conversations/c1', session: ALICE });
    // The route's own catch answers 500 rather than serving an unchecked list.
    assert.strictEqual(res.statusCode, 500);
    assert.ok(!JSON.stringify(res.body || {}).includes('kb-a'));
});
