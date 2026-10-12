/**
 * GET /agents/:id/usage — the "Used by" tab.
 *
 * Three properties, and the last two are the ones a reassuring implementation
 * gets wrong:
 *
 *   • It asks for the EDIT right. Someone who may not see the agent at all
 *     gets the same 404 `GET /:id` gives them; someone who may chat with it
 *     but not edit it gets the editor's 403. "Who uses this agent" is not a
 *     question the audience gets to ask.
 *   • "I could not check apps" must never render as "nothing uses this". The
 *     kinds that failed ride in `unchecked`, including the conversation count
 *     — `chat: null` is unknown, not zero.
 *   • The list must not become a directory. A row the asker does not own is
 *     COUNTED but not named, and `counts` is computed BEFORE redaction so the
 *     number stays honest.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/usage.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    userId: 'me',
    agents: {},
    usage: { rows: [], partial: [] },
    usageThrows: false,
    chat: null,
    chatThrows: false,
    canRead: true,
    canModify: true,
    testChats: 0,
    testChatsThrow: false,
};

// Only the two DB reads are faked. `redactForeign` and `KINDS` reach the
// route straight from the module, so this suite exercises the real ones —
// which is the point: a redaction a test could switch off proves nothing.
const realUsage = require('../../stores/agent/agentUsage');

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => (fx.agents[id] ? { ...fx.agents[id] } : null),
        usageForAgent: async () => {
            if (fx.usageThrows) throw new Error('every scan is down');
            return fx.usage;
        },
        getAgentChatStats: async (ids) => {
            if (fx.chatThrows) throw new Error('conversations unreachable');
            return new Map(ids.map(id => [id, fx.chat]));
        },
    },
    '../../stores/usageStore': {
        getTestChatCounts: async (ids) => {
            if (fx.testChatsThrow) throw new Error('usage log unreachable');
            return new Map(ids.map(id => [id, fx.testChats]));
        },
    },
    '../../utils/routeHelpers': { getEffectiveUserId: () => fx.userId },
    './crud': {
        canReadAgent: async () => fx.canRead,
        canModifyAgent: async () => fx.canModify,
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-usage:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]usage\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./usage');
const { audienceOf } = router;
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch({ url, session = { user: { id: fx.userId } } }) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'GET', url, originalUrl: url, path: url, body: {}, query: {}, headers: {}, session,
            get() { return undefined; },
        };
        const res = {
            statusCode: 200,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error(`fell through router: GET ${url}`)));
    });
}

const AGENT = (over = {}) => ({
    id: 'a1', owner_id: 'me', organization_id: 'org1',
    is_published: false, shared_groups: [], ...over,
});

test.beforeEach(() => {
    fx.userId = 'me';
    fx.agents = { a1: AGENT() };
    fx.usage = { rows: [], partial: [] };
    fx.usageThrows = false;
    fx.chat = { conversationCount: 0, userCount: 0, othersConversationCount: 0, lastUsedAt: null };
    fx.chatThrows = false;
    fx.canRead = true;
    fx.canModify = true;
    fx.testChats = 0;
    fx.testChatsThrow = false;
});

// ── Who may ask ─────────────────────────────────────────────────────

test('an agent that is not there is a 404', async () => {
    const res = await dispatch({ url: '/nope/usage' });
    assert.strictEqual(res.statusCode, 404);
});

test('someone who may not read the agent gets 404, not 403 — existence is not disclosed', async () => {
    fx.canRead = false;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.statusCode, 404);
    assert.ok(!res.body.usage);
});

test('someone who may chat with it but not edit it gets the editor 403', async () => {
    fx.canModify = false;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'agent_not_editable');
    assert.ok(!res.body.usage, 'not even a count leaks to the audience');
});

// ── Testgesprekken staan naast het gesprekgetal, nooit erin (A4) ────

test('test chats are counted separately from conversations', async () => {
    fx.chat = { conversationCount: 4, userCount: 1, othersConversationCount: 0, lastUsedAt: null };
    fx.testChats = 7;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.body.chat.conversationCount, 4,
        'a test chat writes no conversation row — it can never move this number');
    assert.strictEqual(res.body.testChats, 7);
});

test('a test-chat count nobody could read is null, and does NOT block deleting the agent', async () => {
    fx.testChatsThrow = true;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.body.testChats, null, 'unknown, never zero');
    assert.ok(!res.body.unchecked.includes('test_chats'),
        '`unchecked` is what the delete guard refuses on — a test chat has nothing to lose, ' +
        'so an unreadable count of them must never make an agent undeletable');
});

// ── Unknown is never zero ───────────────────────────────────────────

test('a kind the scan could not check rides in unchecked', async () => {
    fx.usage = { rows: [], partial: ['app', 'webpage'] };
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.usage, []);
    assert.deepStrictEqual(res.body.unchecked, ['app', 'webpage']);
});

test('a scan pass that throws wholesale marks EVERY kind unknown', async () => {
    fx.usageThrows = true;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.statusCode, 200, 'the tab still renders');
    assert.deepStrictEqual(res.body.unchecked, [...realUsage.KINDS]);
    assert.deepStrictEqual(res.body.counts, {}, 'and it claims nothing');
});

test('a scan result this route cannot read is unknown, not an empty list', async () => {
    // A store handing back a shape nobody expected must land on the same
    // answer as a store that threw — not on a 500, and certainly not on a
    // readable `rows: []` with the partial list silently dropped.
    for (const bad of [{}, { rows: null, partial: null }, null]) {
        fx.usage = bad;
        const res = await dispatch({ url: '/a1/usage' });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(bad));
        assert.deepStrictEqual(res.body.usage, []);
        assert.deepStrictEqual(res.body.unchecked.filter(k => k !== 'chat'), [...realUsage.KINDS]);
    }
});

test('a conversation count that fails is chat:null plus "chat" in unchecked', async () => {
    // Zero conversations and "I could not count them" are different answers,
    // and the delete guard acts on the difference.
    fx.chatThrows = true;
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.body.chat, null);
    assert.ok(res.body.unchecked.includes('chat'));
});

test('the asker is the one excluded from othersConversationCount', async () => {
    const store = MOCKS['../../stores/agentStore'];
    const original = store.getAgentChatStats;
    let seen = null;
    store.getAgentChatStats = async (ids, opts) => { seen = opts; return original(ids, opts); };
    try {
        fx.userId = 'me';
        await dispatch({ url: '/a1/usage' });
    } finally {
        store.getAgentChatStats = original;
    }
    assert.strictEqual(seen.excludeUserId, 'me');
});

// ── Counted, not named ──────────────────────────────────────────────

test('a colleague\'s automation is counted but not named', async () => {
    fx.usage = {
        rows: [
            { kind: 'task', id: 't1', title: 'Mine', role: 'automation', ownerId: 'me', lastAt: null },
            { kind: 'task', id: 't2', title: 'Payroll export', role: 'automation', ownerId: 'someone-else', lastAt: null },
        ],
        partial: [],
    };
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.body.usage[0].title, 'Mine');
    assert.strictEqual(res.body.usage[1].title, null);
    assert.strictEqual(res.body.usage[1].foreign, true);
    assert.deepStrictEqual(res.body.counts, { task: 2 }, 'the count is taken BEFORE the name is dropped');
});

// ── The Chat row ────────────────────────────────────────────────────

test('the chat row carries the audience and the counts', async () => {
    fx.agents.a1 = AGENT({ is_published: true, shared_groups: ['g-sales'] });
    fx.chat = { conversationCount: 312, userCount: 7, othersConversationCount: 300, lastUsedAt: '2026-09-05T10:00:00.000Z' };
    const res = await dispatch({ url: '/a1/usage' });
    assert.deepStrictEqual(res.body.audience, {
        isPublished: true, scope: 'groups', groupIds: ['g-sales'], organizationId: 'org1',
    });
    assert.strictEqual(res.body.chat.conversationCount, 312);
    assert.strictEqual(res.body.chat.lastUsedAt, '2026-09-05T10:00:00.000Z');
});

test('no conversation title, id or participant ever leaves this endpoint', async () => {
    // The tab needs "312 conversations, last used 2 minutes ago". A title is
    // somebody's own words and its reader here is not its author.
    fx.chat = { conversationCount: 312, userCount: 7, othersConversationCount: 300, lastUsedAt: '2026-09-05T10:00:00.000Z' };
    const res = await dispatch({ url: '/a1/usage' });
    assert.deepStrictEqual(Object.keys(res.body.chat).sort(),
        ['conversationCount', 'lastUsedAt', 'othersConversationCount', 'userCount']);
});

test('a batch that came back without this agent is chat:null AND says so', async () => {
    // A silent null the client has no name for is the same lie as a zero.
    const store = MOCKS['../../stores/agentStore'];
    const original = store.getAgentChatStats;
    store.getAgentChatStats = async () => new Map();
    try {
        const res = await dispatch({ url: '/a1/usage' });
        assert.strictEqual(res.body.chat, null);
        assert.ok(res.body.unchecked.includes('chat'));
    } finally {
        store.getAgentChatStats = original;
    }
});

test('an agent nobody ever chatted with is zeros, and is NOT reported as unchecked', async () => {
    const res = await dispatch({ url: '/a1/usage' });
    assert.strictEqual(res.body.chat.conversationCount, 0);
    assert.ok(!res.body.unchecked.includes('chat'), 'a real zero is a fact, not a gap');
});

// ── audienceOf ──────────────────────────────────────────────────────

test('an unpublished agent is private, whatever groups are left on the row', async () => {
    // shared_groups survives an unpublish; reading it as an audience would
    // tell the tab a draft is shared with Sales.
    assert.deepStrictEqual(audienceOf({ is_published: false, shared_groups: ['g1'], organization_id: 'org1' }), {
        isPublished: false, scope: 'private', groupIds: [], organizationId: 'org1',
    });
});

test('published with no groups is the whole organisation; with groups it is those groups', async () => {
    assert.strictEqual(audienceOf({ is_published: true, shared_groups: [], organization_id: 'org1' }).scope, 'organization');
    assert.strictEqual(audienceOf({ is_published: true, shared_groups: ['g1'], organization_id: 'org1' }).scope, 'groups');
});

test('a row with no shared_groups at all is the whole organisation', async () => {
    assert.deepStrictEqual(audienceOf({ is_published: true, organization_id: null }), {
        isPublished: true, scope: 'organization', groupIds: [], organizationId: null,
    });
    assert.strictEqual(audienceOf({ is_published: true, shared_groups: '[]' }).scope, 'organization');
});

test('shared_groups still in its stored JSON-string form is read, not shrugged at', async () => {
    const a = audienceOf({ is_published: true, shared_groups: '["g-sales"]', organization_id: 'org1' });
    assert.strictEqual(a.scope, 'groups');
    assert.deepStrictEqual(a.groupIds, ['g-sales']);
});

test('a shared_groups value that cannot be READ is a restriction, not "the whole organisation"', async () => {
    // The reassuring reading of an unparseable restriction is the one an
    // editor would act on: "everyone in the org already has this" is how an
    // agent gets left published to people it was never shared with.
    for (const raw of ['{oops', 42, { g: 1 }]) {
        const a = audienceOf({ is_published: true, shared_groups: raw, organization_id: 'org1' });
        assert.strictEqual(a.scope, 'groups', `unreadable ${JSON.stringify(raw)} must narrow`);
        assert.deepStrictEqual(a.groupIds, []);
    }
});
