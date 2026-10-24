'use strict';

/**
 * The TEST CHAT on the ordinary chat door (A4 part A).
 *
 * `POST /agents/:id/chat/stream` with `{ test: true }`. Four properties, each with
 * its own test, because each can become untrue in a different place:
 *
 *   • IT IS A BUILDER'S RIGHT. The test chat serves the UNPUBLISHED draft. Someone who
 *     may talk to the agent but may not edit it should not be able to read work-in-progress,
 *     and an authorisation check that could not run is not a yes.
 *   • IT IS EPHEMERAL, ALWAYS. Even when the client sends `ephemeral: false`.
 *     That one fact is what keeps a test conversation out of the history, out of the card footer
 *     (A5), out of the Used-by tab and out of every export: no row is written, so there is
 *     nothing anywhere to filter.
 *   • IT RUNS ON THE A1c PATH. `asGroup` goes through `gateTestAsRequest`, also together with
 *     `test: true` — one gate, no second one beside it.
 *   • AN ORDINARY TURN REMAINS AN ORDINARY TURN. `test` that is not literally `true` is not
 *     a test chat; otherwise a real conversation would quietly vanish from the history because
 *     `test: 'false'` stood somewhere in a body.
 *
 * Run: cd server && node --test routes/agents/chat.testChat.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const fx = {
    userId: 'me',
    agent: null,
    canModify: true,
    modifyThrows: false,
    groups: {},
    ownGroups: [],
    metadata: [],
    conversationReads: 0,
};

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async () => (fx.agent ? { ...fx.agent } : null),
        getConversationById: async () => { fx.conversationReads++; return { id: 'c1', title: 'Existing', messages: [] }; },
        updateConversationTitle: async () => {},
    },
    '../../core/agentRuntime': {
        chatWithAgentStream: async (agentId, userId, message, userAuth, onEvent, history, metadata) => {
            fx.metadata.push(metadata);
            return { conversationId: 'c1', conversationLength: 2 };
        },
        generateChatTitle: async () => 'Title',
    },
    '../../core/aiAgent': { getAIConfig: async () => ({}), getProviderForModel: async () => ({}) },
    '../../stores/configStore': { get: async () => null, set: async () => {} },
    '../../auth': {
        requirePermission: () => (req, res, next) => next(),
        requireAuth: (req, res, next) => next(),
        resolveUserOrgIds: async () => new Set(['org1']),
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': {
        getEffectiveUserId: () => fx.userId,
        getUserAuth: async () => ({ userId: fx.userId, userOrgId: 'org1', session: {} }),
    },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
    '../../stores/userStore': { getUser: async () => ({ id: fx.userId, organizationId: 'org1', groups: [] }) },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../core/entitlements/limits': {
        checkSubscriptionLimits: async () => null,
        checkResourceLimits: async () => null,
    },
    '../../core/http/sseHelpers': {
        setupSSE: (res) => {
            res.events = [];
            return {
                abortController: new AbortController(),
                markEnded: () => {},
                sendEvent: (event, data) => { res.events.push({ event, data }); },
            };
        },
        sendSSEError: (res, err) => { res.body = { error: err }; res.statusCode = 402; },
        persistAndTitle: async () => {},
        getOrCreateAgentConversation: async () => ({ id: 'c1' }),
    },
    './crud': {
        canModifyAgent: async () => {
            if (fx.modifyThrows) throw new Error('permission store down');
            return fx.canModify;
        },
        canReadAgent: async () => true,
    },
};

const realAudience = require('../../auth/audience');
const TEST_AS_MOCKS = {
    '../../stores/userStore': {
        getGroup: async (id) => fx.groups[id] || null,
    },
    '../../auth/audience': {
        resolveUserGroups: async () => fx.ownGroups,
        canSeePublished: realAudience.canSeePublished,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-chat-testchat:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const TEST_AS_IDS = {};
for (const [request, exportsObj] of Object.entries(TEST_AS_MOCKS)) {
    const mockId = `mock:agent-chat-testchat:inner:${request}`;
    TEST_AS_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]chat\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    if (parent && /agentRuntime[\\/]testAs\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(TEST_AS_IDS, request)) {
        return TEST_AS_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./chat');
test.after(() => { Module._resolveFilename = originalResolve; });

function dispatch(body) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'POST', url: '/a1/chat/stream', originalUrl: '/a1/chat/stream',
            path: '/a1/chat/stream', body, query: {}, headers: {},
            session: { user: { id: fx.userId } },
            get() { return undefined; },
        };
        const res = {
            statusCode: 200, events: [], writableEnded: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { this.writableEnded = true; resolve(this); return this; },
            setHeader() {}, flushHeaders() {}, write() {}, on() {},
        };
        router(request, res, (err) => reject(err || new Error('fell through router')));
    });
}

test.beforeEach(() => {
    Object.assign(fx, {
        userId: 'me',
        agent: { id: 'a1', owner_id: 'me', organization_id: 'org1', is_published: true, shared_groups: [] },
        canModify: true, modifyThrows: false,
        groups: { sales: { id: 'sales', name: 'Sales', organizationId: 'org1' } },
        ownGroups: [],
        metadata: [], conversationReads: 0,
    });
});

test('an editor asking for a test chat gets one, and it is ephemeral', async () => {
    await dispatch({ message: 'hi', test: true });
    assert.strictEqual(fx.metadata.length, 1);
    assert.strictEqual(fx.metadata[0].testChat, true);
    assert.strictEqual(fx.metadata[0].ephemeral, true);
    assert.strictEqual(fx.conversationReads, 0, 'a test conversation is never persisted');
});

test('a client that asks for a persisted test chat still gets an ephemeral one', async () => {
    // This is the property that all other counts lean on. Were `ephemeral`
    // overridable here, then one client flag would make a test conversation appear in the
    // history, the card footer and the Used-by tab as an ordinary conversation — and then each of
    // those numbers would be untrue.
    await dispatch({ message: 'hi', test: true, ephemeral: false, conversationId: 'c9' });
    assert.strictEqual(fx.metadata[0].ephemeral, true);
    assert.strictEqual(fx.conversationReads, 0);
});

test('someone who may chat but not edit cannot open a test chat', async () => {
    fx.canModify = false;
    const res = await dispatch({ message: 'hi', test: true });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'test_chat_not_allowed');
    assert.deepStrictEqual(fx.metadata, [], 'the turn must not run');
});

test('an edit check that could not run is not permission to test', async () => {
    fx.modifyThrows = true;
    // The route throws; the terminal handler answers (error, code at the top
    // level, `codes` under `details`).
    const err = await dispatch({ message: 'hi', test: true }).then(
        (res) => { throw new Error(`expected a refusal, got ${res.statusCode}`); },
        (e) => e,
    );
    assert.strictEqual(err.status, 503);
    assert.strictEqual(err.code, 'test_chat_check_failed');
    assert.deepStrictEqual(err.details, { codes: ['test_chat_check_failed'] });
    assert.deepStrictEqual(fx.metadata, []);
});

test('test + asGroup rides the A1c gate — one door, not two', async () => {
    await dispatch({ message: 'hi', test: true, asGroup: 'sales' });
    assert.strictEqual(fx.metadata[0].testChat, true);
    assert.deepStrictEqual(fx.metadata[0].testAs, { groupId: 'sales', groupName: 'Sales', orgId: 'org1' });
});

test('an unresolvable group refuses the whole request, test chat or not', async () => {
    fx.groups = {};
    const res = await dispatch({ message: 'hi', test: true, asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'test_as_group_not_found');
    assert.deepStrictEqual(fx.metadata, [], 'never downgraded to a plain test chat');
});

test('an ordinary turn is untouched and still persists', async () => {
    await dispatch({ message: 'hi' });
    assert.strictEqual(fx.metadata[0].testChat, false);
    assert.strictEqual(fx.metadata[0].ephemeral, undefined);
    assert.strictEqual(fx.metadata[0].toolDecisions, undefined);
    assert.strictEqual(fx.conversationReads, 1);
});

test('a truthy-but-not-true `test` is refused, and is never a test chat', async () => {
    // `wantsTestChat` asks for `=== true`, so these used to run as ORDINARY
    // turns: against the published agent, written to the real history and
    // counted in the usage tab, while the caller believed it was testing.
    // The affordance is a boolean, and the schema says so by name.
    for (const value of ['true', 1, 'yes', {}]) {
        fx.metadata.length = 0;
        fx.conversationReads = 0;
        const err = await dispatch({ message: 'hi', test: value }).then(
            (res) => { throw new Error(`expected a refusal, got ${res.statusCode}`); },
            (e) => e,
        );
        assert.strictEqual(err.status, 400, `test: ${JSON.stringify(value)}`);
        assert.strictEqual(err.code, 'invalid_request');
        assert.ok(err.details.some((d) => d.path === 'body.test'), JSON.stringify(err.details));
        assert.deepStrictEqual(fx.metadata, [], 'and no turn runs at all');
        assert.strictEqual(fx.conversationReads, 0);
    }
});

test('`test: false` is an ordinary turn, and still persists', async () => {
    await dispatch({ message: 'hi', test: false });
    assert.strictEqual(fx.metadata[0].testChat, false);
    assert.strictEqual(fx.metadata[0].ephemeral, undefined);
    assert.strictEqual(fx.conversationReads, 1);
});

test('tool decisions only travel on a test chat, and only in the cleaned shape', async () => {
    const decisions = [
        { toolName: 'gmail_send', argsKey: 'a'.repeat(32), decision: 'approve' },
        { toolName: 'gmail_send', argsKey: 'nope', decision: 'approve' },
    ];
    await dispatch({ message: 'hi', test: true, toolDecisions: decisions });
    const passed = fx.metadata[0].toolDecisions;
    assert.ok(passed instanceof Map);
    assert.strictEqual(passed.size, 1, 'a malformed key is dropped, not trusted');
    assert.strictEqual(passed.get('a'.repeat(32)), 'approve');

    fx.metadata.length = 0;
    await dispatch({ message: 'hi', toolDecisions: decisions });
    assert.strictEqual(fx.metadata[0].toolDecisions, undefined,
        'an ordinary chat cannot smuggle an approval in');
});
