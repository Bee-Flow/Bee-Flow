'use strict';

/**
 * "Test als · groep X" on the agent chat stream.
 *
 * The Testen tab previews an agent by talking to it, so the simulation has to
 * exist on the ordinary chat door as well as on the test-set runner. That door
 * is the one with the sharp edges, and this file pins the three of them:
 *
 *   • IT IS AN EDITOR'S TOOL. Simulating only ever removes knowledge, so a
 *     chatter could not gain anything by asking — but the answer to "may I
 *     preview this agent as somebody else" is `canModifyAgent`, and a check
 *     that could not RUN is not a yes.
 *   • IT REFUSES, IT NEVER DEGRADES. A group that cannot be resolved comes
 *     back as a 400/503 before the stream opens. The alternative — run the
 *     turn as the person actually typing and let the client keep its label —
 *     is a transcript that says a group saw something it did not.
 *   • IT IS EPHEMERAL. A narrowed answer written into the agent's real history
 *     would later read as what the agent said to this person, and would count
 *     as a conversation in the usage tab.
 *
 * `core/agentRuntime/testAs` is the real module; only the two reads it makes
 * are replaced.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/chat.testAs.test.js
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
    groupThrows: false,
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
        getGroup: async (id) => {
            if (fx.groupThrows) throw new Error('groups table unreachable');
            return fx.groups[id] || null;
        },
    },
    '../../auth/audience': {
        resolveUserGroups: async () => fx.ownGroups,
        canSeePublished: realAudience.canSeePublished,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-chat-testas:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const TEST_AS_IDS = {};
for (const [request, exportsObj] of Object.entries(TEST_AS_MOCKS)) {
    const mockId = `mock:agent-chat-testas:inner:${request}`;
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
        ownGroups: [], groupThrows: false,
        metadata: [], conversationReads: 0,
    });
});

test('an editor naming a group gets a simulated, ephemeral turn', async () => {
    await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(fx.metadata.length, 1);
    assert.deepStrictEqual(fx.metadata[0].testAs, { groupId: 'sales', groupName: 'Sales', orgId: 'org1' });
    assert.strictEqual(fx.metadata[0].ephemeral, true, 'a narrowed answer is not the agent\'s history');
    assert.strictEqual(fx.conversationReads, 0, 'nothing may be persisted for a preview');
});

test('an ordinary turn is untouched', async () => {
    await dispatch({ message: 'hi' });
    assert.strictEqual(fx.metadata[0].testAs, null);
    assert.strictEqual(fx.metadata[0].ephemeral, undefined);
    assert.strictEqual(fx.conversationReads, 1, 'a real chat still persists');
});

test('someone who may chat but not edit cannot preview as a group', async () => {
    fx.canModify = false;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(res.body.code, 'test_as_not_allowed');
    assert.deepStrictEqual(fx.metadata, [], 'the turn must not run');
});

test('an edit check that could not run is not permission to simulate', async () => {
    fx.modifyThrows = true;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.code, 'test_as_check_failed');
    assert.deepStrictEqual(fx.metadata, []);
});

test('a group that cannot be resolved refuses instead of running as the editor', async () => {
    const unknown = await dispatch({ message: 'hi', asGroup: 'marketing' });
    assert.strictEqual(unknown.statusCode, 400);
    assert.strictEqual(unknown.body.code, 'test_as_group_not_found');
    assert.deepStrictEqual(fx.metadata, []);

    fx.groupThrows = true;
    const down = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(down.statusCode, 503);
    assert.strictEqual(down.body.code, 'test_as_group_unreadable');
    assert.deepStrictEqual(fx.metadata, []);
});

test('an embed visitor with no session cannot simulate anybody', async () => {
    // A visitor without an account reaches the turn at all only on an agent
    // with Web embed on (chat.embed.test.js); past that door the edit check
    // answers no, and no is where this stops.
    fx.userId = null;
    fx.agent = { ...fx.agent, embed_enabled: true };
    fx.canModify = false;
    const res = await dispatch({ message: 'hi', asGroup: 'sales' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(fx.metadata, []);
});

test('a group from another organisation is not previewable', async () => {
    fx.groups = { hr: { id: 'hr', name: 'HR', organizationId: 'org2' } };
    const res = await dispatch({ message: 'hi', asGroup: 'hr' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'test_as_group_not_found');
});
