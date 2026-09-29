/**
 * Who may change direct chat for everyone, and what they may send
 * (routes/ai/config/directChatSettings.js).
 *
 * All three rows are instance-wide and every write carried requireAuth only:
 * any signed-in user could replace the system prompt every other user's chat
 * runs under, or pin a tool's parameters for the whole instance — and READ
 * those pinned parameters, which is where a pinned API key lives. And the
 * shapes were never checked, so a wrong one failed later — in every chat on
 * that tier — and a misspelled `systemPrompt` WIPED the prompt with a 200.
 *
 * Run: cd server && node --test routes/ai/config/directChatSettings.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const writes = [];
const fx = { isAdmin: true, stored: {} };

const MOCKS = {
    '../../../stores/configStore': {
        getConfig: async (key) => fx.stored[key] ?? null,
        setConfig: async (key, value) => { writes.push([key, value]); },
    },
    './shared': { isAdminUser: async () => fx.isAdmin },
    '../../../auth/permissions': { requireAuth: (req, res, next) => next() },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:direct-chat-settings-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /config[\\/]directChatSettings\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./directChatSettings');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { writes.length = 0; fx.isAdmin = true; fx.stored = {}; });

// ═══ Who may write ═══════════════════════════════════════════════════

for (const [url, body] of [
    ['/config/direct-chat', { systemPrompt: 'Always answer in pirate speak.' }],
    ['/config/direct-chat-tools', { fast: [] }],
    ['/config/direct-chat-tool-params', { fast: { 'http-request': { url: 'https://collector.example' } } }],
]) {
    test(`${url}: a signed-in non-admin is refused — the row is every user's`, async () => {
        fx.isAdmin = false;
        const res = await dispatch({ method: 'POST', url, body });
        assert.strictEqual(res.statusCode, 403);
        assert.deepStrictEqual(res.body, { error: 'Admin access required' });
        assert.deepStrictEqual(writes, []);
    });
}

// ═══ Who may read the pinned parameters ═════════════════════════════

test('the pinned tool parameters are not readable by a signed-in non-admin — they carry pinned keys', async () => {
    fx.isAdmin = false;
    fx.stored = { direct_chat_tier_tool_params: { fast: { 'http-request': { apiKey: 'pinned-secret' } } } };
    const res = await dispatch({ method: 'GET', url: '/config/direct-chat-tool-params' });
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Admin access required' });
    assert.ok(!JSON.stringify(res.body).includes('pinned-secret'));
});

test('an admin still reads them, and a member still reads the prompt and the tier lists', async () => {
    fx.stored = {
        direct_chat_tier_tool_params: { fast: { 'http-request': { apiKey: 'pinned-secret' } } },
        direct_chat_system_prompt: 'Be brief.',
        direct_chat_tier_tools: { fast: ['tavily-search'] },
    };
    const admin = await dispatch({ method: 'GET', url: '/config/direct-chat-tool-params' });
    assert.strictEqual(admin.statusCode, 200);
    assert.deepStrictEqual(admin.body, fx.stored.direct_chat_tier_tool_params);

    fx.isAdmin = false;
    const prompt = await dispatch({ method: 'GET', url: '/config/direct-chat' });
    assert.deepStrictEqual([prompt.statusCode, prompt.body], [200, { systemPrompt: 'Be brief.' }]);
    const tools = await dispatch({ method: 'GET', url: '/config/direct-chat-tools' });
    assert.deepStrictEqual([tools.statusCode, tools.body], [200, { fast: ['tavily-search'] }]);
});

// ═══ The system prompt ═══════════════════════════════════════════════

test('a misspelled key is refused — it used to WIPE the prompt and say saved', async () => {
    for (const body of [{ prompt: 'Be brief.' }, { sytemPrompt: 'Answer in Dutch.' }]) {
        const res = await dispatch({ method: 'POST', url: '/config/direct-chat', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
    }
    assert.deepStrictEqual(writes, [], 'the stored prompt keeps its value');
});

test('an empty prompt still means "use the default", which is what the page sends', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat', body: { systemPrompt: '' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['direct_chat_system_prompt', '']]);
});

test('a prompt that is not text is refused by name', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat', body: { systemPrompt: ['Be brief.'] } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.systemPrompt'));
    assert.deepStrictEqual(writes, []);
});

// ═══ The tier maps ═══════════════════════════════════════════════════

test('a tier mapped to an object of tools is refused — `.includes` threw in every chat on it', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat-tools', body: { fast: { 'tavily-search': true } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.fast'));
    assert.deepStrictEqual(writes, []);
});

test('a tier mapped to a string is refused — it was matched as a substring', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat-tools', body: { fast: 'tavily-search' } });
    assert.strictEqual(res.statusCode, 400);
    assert.deepStrictEqual(writes, []);
});

test('tier lists keep custom tiers and an empty list (no component tools on that tier)', async () => {
    const body = { fast: ['tavily-search'], 'custom:legal': [], thinking: ['get-date-time', 'tavily-search'] };
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat-tools', body });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['direct_chat_tier_tools', body]]);
});

test('pinned parameters must be an object per tool — a string was spread character by character', async () => {
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat-tool-params', body: { fast: { 'tavily-search': 'max_results=3' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.fast.tavily-search'));
    assert.deepStrictEqual(writes, []);
});

test('well-formed pinned parameters are stored as sent', async () => {
    const body = { fast: { 'tavily-search': { max_results: 3, topic: 'news' } } };
    const res = await dispatch({ method: 'POST', url: '/config/direct-chat-tool-params', body });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(writes, [['direct_chat_tier_tool_params', body]]);
});
