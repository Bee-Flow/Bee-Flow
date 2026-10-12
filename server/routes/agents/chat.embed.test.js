'use strict';

/**
 * The public side of an agent: its embed page, and who may talk to it without
 * signing in (routes/agents/chat.js).
 *
 * Web embed is the ONE switch that makes an agent public. The editor asks
 * before turning it on — "Make this agent public? Anyone who knows the URL
 * will be able to chat with this agent without an account"
 * (EnableEmbedConfirmModal) — and the course on publishing says it "creates a
 * public chat page" that "needs an audience as well as the switch". So:
 *
 *   - GET /:id/embed shows the page only for a published, embed-enabled agent,
 *     and says what its owner chose about the copy button. It said `true`
 *     whatever the owner chose: `copy_enabled !== 0`, and Postgres hands back
 *     `false`, not 0. And it read only that column, while the agent editor
 *     keeps the choice in `config.allowCopy`.
 *   - A visitor who is not signed in may take a turn only where that page
 *     exists. The turn routes checked `is_published` and nothing else for
 *     them: `getEffectiveUserId` gives every visitor a `guest_…` id, so the
 *     branch commented "(embed flow)" was never reached and the visitor went
 *     through the signed-in access check as an org-less user — which admits
 *     every published agent that has no org, embed switch on or off.
 *   - Both turn routes refuse such a visitor with the answer an unpublished
 *     agent gets, so the refusal says nothing about whether an id was ever
 *     published.
 *
 * Signed-in people are not affected: the embed switch is not an audience
 * rule for them, and the tests below pin that too.
 *
 * Run: cd server && node --test routes/agents/chat.embed.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const seen = [];
const pass = (req, res, next) => next();
/** What the chat-signals resolver answers, and which org keys it was asked about. */
const monitoring = { answer: null, asked: [] };

/**
 * A published agent that belongs to no organisation, with every setting as
 * Postgres returns it (booleans). Tests replace fields.
 */
const BASE_AGENT = Object.freeze({
    id: 'a1',
    name: 'Contract reader',
    description: 'Reads supplier contracts',
    avatar: '📄',
    owner_id: 'owner1',
    organization_id: null,
    is_published: true,
    shared_groups: [],
    starter_prompts: ['Summarise this contract', ' '],
    threads_enabled: true,
    copy_enabled: true,
    workspace_enabled: false,
    embed_enabled: false,
    // getForRuntime always hands back a parsed object here, never NULL.
    config: {},
});
let agent = { ...BASE_AGENT };

/** The real getEffectiveUserId hands a visitor without an account a guest id. */
const effectiveUserId = (req) => req.session?.user?.id || 'guest_0f0f0f0f0f0f0f0f0f0f0f0f';

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async () => ({ ...agent }),
        getForRuntime: async () => ({ ...agent }),
        getConversationById: async () => ({ id: 'c1', title: 'x', messages: [] }),
        updateConversationTitle: async () => {},
    },
    '../../core/agentRuntime': {
        chatWithAgentStream: async (agentId, userId, message, userAuth, onEvent, history, metadata) => {
            seen.push({ what: 'stream', userId, metadata });
            return { conversationId: 'c1', conversationLength: 2 };
        },
        chatWithAgent: async (agentId, userId, message) => { seen.push({ what: 'chat', userId, message }); return { reply: 'ok' }; },
        generateChatTitle: async () => 'Title',
    },
    '../../core/aiAgent': { getAIConfig: async () => ({}), getProviderForModel: async () => ({}) },
    '../../stores/configStore': { get: async () => null, set: async () => {} },
    '../../auth': {
        requirePermission: () => pass,
        requireAuth: pass,
        // orgScope: a visitor without an account reaches no org; a signed-in
        // user in these tests has none either (an org-less account).
        resolveUserOrgIds: async () => new Set(),
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': {
        getEffectiveUserId: effectiveUserId,
        getUserAuth: async (req) => ({ userId: effectiveUserId(req), userOrgId: null, session: {} }),
    },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    // No users row for a guest id; an org-less account for a signed-in one.
    '../../stores/userStore': { getUser: async (id) => (id.startsWith('guest_') ? null : { id, organizationId: '', groups: [] }) },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null, checkResourceLimits: async () => null },
    '../../core/http/sseHelpers': {
        setupSSE: () => ({ abortController: new AbortController(), markEnded: () => {}, sendEvent: () => {} }),
        sendSSEError: (res, err) => { res.body = { error: err }; res.statusCode = 402; },
    },
    './crud': { canModifyAgent: async () => false, canReadAgent: async () => false },
    // Chat signals: the resolver for the agent's org (the embed's notice).
    '../../core/entitlements/chatMonitoringFlag': {
        resolveChatMonitoring: async (orgKey) => { monitoring.asked.push(orgKey); return monitoring.answer; },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-chat-embed:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]chat\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./chat');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

/**
 * `session` is what express-session leaves on the request: an object for
 * everyone, with a `user` only once somebody signed in.
 */
function dispatch({ method = 'POST', url, body, user = null }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: user ? { user: { id: user } } : {}, get() { return undefined; },
        };
        const res = {
            statusCode: 200, writableEnded: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { this.writableEnded = true; resolve(this); return this; },
            setHeader() {}, flushHeaders() {}, write() {}, on() {},
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { seen.length = 0; agent = { ...BASE_AGENT }; monitoring.answer = null; monitoring.asked = []; });

const turn = (user) => dispatch({ url: '/a1/chat/stream', body: { message: 'hi', ephemeral: true }, user });

// ═══ GET /:id/embed ═════════════════════════════════════════════════

test('the embed page offers no copy button when the owner switched copying off', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: false };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.copyEnabled, false);
});

test('the embed page offers the copy button when the owner left copying on', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: true };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.body.copyEnabled, true);
});

test('an agent whose row holds no copy value falls back to the column default (on)', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: null };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.body.copyEnabled, true);
});

// The agent editor people use today (BuilderSplit, "Allow copying") keeps
// the choice in `config.allowCopy` and never writes `copy_enabled`; the older
// designer writes the column. The in-app chat honours the config key, so the
// public page has to honour both: either one saying no is the owner saying no.
test('the embed page offers no copy button when the owner switched copying off in the agent editor', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: true, config: { allowCopy: false } };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.copyEnabled, false);
});

test('copying switched on in the editor does not override the older copy setting being off', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: false, config: { allowCopy: true } };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.body.copyEnabled, false);
});

test('copying switched on in both places offers the copy button', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, copy_enabled: true, config: { allowCopy: true } };
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.body.copyEnabled, true);
});

test('the embed page does not exist for an agent whose owner left Web embed off', async () => {
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.statusCode, 404);
});

// ═══ A visitor without an account ═══════════════════════════════════

test('a visitor without an account cannot stream a turn with an agent that has no public page', async () => {
    const res = await turn(null);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(seen, [], 'the model must not be reached');
});

test('nor through the older non-streaming turn', async () => {
    const res = await dispatch({ url: '/a1/chat', body: { message: 'hi' } });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(seen, []);
});

test('a visitor without an account CAN talk to an agent whose owner switched Web embed on', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true };
    const res = await turn(null);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.length, 1);
    assert.match(seen[0].userId, /^guest_/);
});

test('a visitor cannot tell an unpublished agent from a published one without a public page', async () => {
    // Both turn routes give the SAME refusal for both, so probing an id says
    // nothing about whether it was ever published.
    for (const url of ['/a1/chat/stream', '/a1/chat']) {
        agent = { ...BASE_AGENT, is_published: false };
        const unpublished = await dispatch({ url, body: { message: 'hi' } });
        agent = { ...BASE_AGENT, is_published: true, embed_enabled: false };
        const noPage = await dispatch({ url, body: { message: 'hi' } });
        assert.deepStrictEqual(
            [unpublished.statusCode, unpublished.body],
            [noPage.statusCode, noPage.body],
            `${url}: unpublished and published-without-embed answer alike`,
        );
        assert.deepStrictEqual([noPage.statusCode, noPage.body], [401, { error: 'Not authenticated' }], url);
    }
    assert.deepStrictEqual(seen, [], 'the model must not be reached');
});

test('a signed-in stranger still gets Access denied on an unpublished agent through the older turn', async () => {
    agent = { ...BASE_AGENT, is_published: false };
    const res = await dispatch({ url: '/a1/chat', body: { message: 'hi' }, user: 'user7' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Access denied' });
    assert.deepStrictEqual(seen, []);
});

test('an unpublished agent stays closed to a visitor even with Web embed on', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, is_published: false };
    const res = await turn(null);
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(seen, []);
});

// ═══ Signed-in people: the switch is not their audience rule ═════════

test('a signed-in account still reaches a published org-less agent with Web embed off', async () => {
    const res = await turn('user7');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].userId, 'user7');
});

// ═══ GET /:id/embed: the chat-signals notice for website visitors ═══

const NOTICE_OFF = { state: 'off', from: null, version: null, signals: [], privacyNoticeUrl: null };
const ON_FOR_VISITORS = {
    state: 'on', version: '2026-10-14T09:00:00.000Z', from: '2026-10-14',
    surfaces: ['direct', 'agent_public'], paused: [{ surface: 'agent', missing: ['dpia_missing'] }],
    signals: ['outcomes', 'kinds'], noticeUrl: 'https://acme.example/chat-signals', visitorNoticeUrl: 'https://acme.example/privacy',
    retentionDays: 30,
};

test('chat signals: the notice appears only when website visitors are counted, from the agent\'s org', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, organization_id: 'org-acme-42' };
    monitoring.answer = ON_FOR_VISITORS;
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.complianceNotice, {
        state: 'on', from: '2026-10-14', version: '2026-10-14T09:00:00.000Z', signals: ['outcomes', 'kinds'],
        privacyNoticeUrl: 'https://acme.example/privacy',
    });
    assert.deepStrictEqual(monitoring.asked, ['org-acme-42']);

    monitoring.answer = { ...ON_FOR_VISITORS, state: 'scheduled' };
    const scheduled = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(scheduled.body.complianceNotice.state, 'scheduled');
});

test('chat signals: the off shape when visitors are not counted, the state is off or the agent has no org', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, organization_id: 'org-acme-42' };
    monitoring.answer = { ...ON_FOR_VISITORS, surfaces: ['direct', 'agent'] };
    assert.deepStrictEqual((await dispatch({ method: 'GET', url: '/a1/embed' })).body.complianceNotice, NOTICE_OFF);
    monitoring.answer = { ...ON_FOR_VISITORS, state: 'off' };
    assert.deepStrictEqual((await dispatch({ method: 'GET', url: '/a1/embed' })).body.complianceNotice, NOTICE_OFF);

    // An agent without an org is never counted, so nothing is announced and
    // the resolver is not even asked.
    agent = { ...BASE_AGENT, embed_enabled: true, organization_id: null };
    monitoring.asked = [];
    monitoring.answer = ON_FOR_VISITORS;
    assert.deepStrictEqual((await dispatch({ method: 'GET', url: '/a1/embed' })).body.complianceNotice, NOTICE_OFF);
    assert.deepStrictEqual(monitoring.asked, []);
});

test('chat signals: a resolver failure reads off; a non-https notice link is dropped', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, organization_id: 'org-acme-42' };
    monitoring.answer = { ...ON_FOR_VISITORS, visitorNoticeUrl: 'http://acme.example/privacy' };
    assert.strictEqual((await dispatch({ method: 'GET', url: '/a1/embed' })).body.complianceNotice.privacyNoticeUrl, null);
    monitoring.answer = Promise.reject(new Error('ECONNREFUSED postgres://beeflow:hunter2@db'));
    monitoring.answer.catch(() => {});
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.complianceNotice, NOTICE_OFF);
});

test('chat signals: the public body carries no org id, no paused list and no employee notice', async () => {
    agent = { ...BASE_AGENT, embed_enabled: true, organization_id: 'org-acme-42' };
    monitoring.answer = ON_FOR_VISITORS;
    const res = await dispatch({ method: 'GET', url: '/a1/embed' });
    assert.deepStrictEqual(Object.keys(res.body.complianceNotice).sort(), ['from', 'privacyNoticeUrl', 'signals', 'state', 'version']);
    const wire = JSON.stringify(res.body);
    for (const leak of ['org-acme-42', 'dpia_missing', 'paused', 'chat-signals', 'retention']) {
        assert.ok(!wire.includes(leak), `the public embed body carries "${leak}"`);
    }
});

