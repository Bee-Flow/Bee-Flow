'use strict';

/**
 * What the agent chat routes accept, and what they say when they refuse
 * (routes/agents/chat.js).
 *
 * The turn body is the widest on the server and it was read key by key with
 * no vocabulary anywhere, so a misspelling did the other thing under a 200:
 *
 *   - `converstionId` started a NEW thread instead of continuing the one on
 *     screen, and the only sign was a reply that had forgotten everything;
 *   - `modelTier: 'thinkin'` fell back to the agent's own model, so the
 *     override the composer offers did nothing and said nothing;
 *   - a `memoryWriteEnabled: 'false'` (the string) is not `false`.
 *
 * Three keys are accepted AND NOT READ — `agentId`, `stream` and `isHidden`.
 * Both clients send them (the Android app types them in AgentTurnPayload),
 * so `.strict()` without them would have refused every turn from Agent Hub
 * and from the app. That check is what this file's last test is for.
 *
 * Run: cd server && node --test routes/agents/chat.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const seen = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => ({ id, owner_id: 'me', organization_id: 'org1', is_published: true, shared_groups: [] }),
        getConversationById: async () => ({ id: 'c1', title: 'x', messages: [] }),
        updateConversationTitle: async () => {},
    },
    '../../core/agentRuntime': {
        chatWithAgentStream: async (agentId, userId, message, userAuth, onEvent, history, metadata) => {
            seen.push({ what: 'stream', message, metadata });
            return { conversationId: 'c1', conversationLength: 2 };
        },
        chatWithAgent: async (agentId, userId, message) => { seen.push({ what: 'chat', message }); return { reply: 'ok' }; },
        generateChatTitle: async () => 'Title',
    },
    '../../core/aiAgent': { getAIConfig: async () => ({}), getProviderForModel: async () => ({}) },
    '../../stores/configStore': { get: async () => null, set: async () => {} },
    '../../auth': {
        requirePermission: () => pass,
        requireAuth: pass,
        resolveUserOrgIds: async () => new Set(['org1']),
    },
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': {
        getEffectiveUserId: () => 'me',
        getUserAuth: async () => ({ userId: 'me', userOrgId: 'org1', session: {} }),
    },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => pass },
    '../../stores/userStore': { getUser: async () => ({ id: 'me', organizationId: 'org1', groups: [] }) },
    '../../stores/usageStore': { logUsage: async () => {} },
    '../../core/entitlements/limits': { checkSubscriptionLimits: async () => null, checkResourceLimits: async () => null },
    '../../core/http/sseHelpers': {
        setupSSE: () => ({
            abortController: new AbortController(),
            markEnded: () => {},
            sendEvent: () => {},
        }),
        sendSSEError: (res, err) => { res.body = { error: err }; res.statusCode = 402; },
        persistAndTitle: async () => {},
        getOrCreateAgentConversation: async () => ({ id: 'c1' }),
        startSseHeartbeat: () => () => {},
    },
    './crud': { canModifyAgent: async () => true, canReadAgent: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-chat-validation:${request}`;
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

function dispatch({ method = 'POST', url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'me' } }, get() { return undefined; },
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

test.beforeEach(() => { seen.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method || 'POST'} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(seen, [], 'a refused request must not reach the runtime');
    return res;
}

// ═══ POST /:id/chat/stream ══════════════════════════════════════════

test('a misspelled conversation id is refused, not read as "start a new thread"', async () => {
    await refuses({ url: '/a1/chat/stream', body: { message: 'hi', converstionId: 'c9' } }, 'body');
});

test('a switch sent as a word is refused by name', async () => {
    await refuses({ url: '/a1/chat/stream', body: { message: 'hi', memoryWriteEnabled: 'false' } }, 'body.memoryWriteEnabled');
});

test('a message left out is refused in words, not with "Required"', async () => {
    const res = await refuses({ url: '/a1/chat/stream', body: {} }, 'body.message');
    assert.strictEqual(res.body.error, 'Message is required');
});

test('the keys both clients send but this route never reads are still accepted', async () => {
    // `agentId` and `stream` come from the Android app's AgentTurnPayload and
    // from Agent Hub; `isHidden` from Agent Hub alone. A `.strict()` without
    // them would have 400'd every turn either of them sends.
    const res = await dispatch({
        url: '/a1/chat/stream',
        body: { message: 'hi', agentId: 'a1', stream: true, isHidden: false, timezone: 'Europe/Amsterdam' },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(seen.find((s) => s.what === 'stream').message, 'hi');
});

test('an empty notebook stays "open but blank", not "no notebook"', async () => {
    const res = await dispatch({
        url: '/a1/chat/stream',
        body: { message: 'hi', notebookspaceAvailable: true, notebookspaceContent: '' },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});

// ═══ POST /:id/chat (the legacy, non-streaming turn) ════════════════

test('a key the legacy turn never read is refused rather than dropped', async () => {
    // It has only ever read `message`. A `conversationId` sent here was
    // discarded, and a reply that did not continue the thread was the only
    // sign of it.
    await refuses({ url: '/a1/chat', body: { message: 'hi', conversationId: 'c9' } }, 'body');
});

test('the legacy turn still answers a plain message', async () => {
    const res = await dispatch({ url: '/a1/chat', body: { message: 'hi' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(seen.find((s) => s.what === 'chat').message, 'hi');
});

// ═══ The two helpers ════════════════════════════════════════════════

test('a title request without content is refused in words', async () => {
    const res = await refuses({ url: '/thread/title', body: {} }, 'body.content');
    assert.strictEqual(res.body.error, 'Content is required');
});

test('a describe request with a misspelled key is refused', async () => {
    await refuses({ url: '/describe-building', body: { cod: 'x' } }, 'body');
});

// ═══ history ════════════════════════════════════════════════════════

test('a history turn whose content is an object is refused by name', async () => {
    // Replayed verbatim, it is the provider's 400 "messages[N].content ... got
    // an object" on every later turn of the conversation.
    await refuses({
        url: '/a1/chat/stream',
        body: { message: 'hi', history: [{ role: 'user', content: 'a' }, { role: 'tool', content: { sent: true } }] },
    }, 'body.history.1.content');
});

test('a history turn that is not an object is refused by name', async () => {
    await refuses({ url: '/a1/chat/stream', body: { message: 'hi', history: ['hello'] } }, 'body.history.0');
});

test('history with text, content blocks, null content and extra fields is accepted', async () => {
    const res = await dispatch({
        url: '/a1/chat/stream',
        body: {
            message: 'hi',
            history: [
                { role: 'user', content: 'a', attachments: [{ name: 'x.pdf' }] },
                { role: 'user', content: [{ type: 'text', text: 'b' }] },
                { role: 'assistant', content: null },
                { role: 'assistant' },
            ],
        },
    });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
});
