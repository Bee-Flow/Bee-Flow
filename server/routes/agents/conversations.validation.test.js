'use strict';

/**
 * What the agent-conversation routes accept, and what they say when they
 * refuse (routes/agents/conversations.js).
 *
 * The hand-written validators these schemas replaced answered in fragments —
 * "invalid title", "labels must be strings" — which name neither the field
 * nor which entry of the list went wrong, and `pinned` accepted a NUMBER that
 * the store then coerced, so `pinned: 0` unpinned and `pinned: 2` pinned by
 * accident. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.labels.1`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request changes nothing.
 *
 * Run: cd server && node --test --test-force-exit routes/agents/conversations.validation.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// ── Fixtures ────────────────────────────────────────────────────────
// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const note = (what) => (...args) => { touched.push({ what, args }); return true; };

const AGENT = { id: 'a1', owner_id: 'u1', is_published: true };
const CONVERSATION = { id: 'c1', user_id: 'u1', workspace_notebook_id: null, workspace_content: '' };

const MOCKS = {
    '../../stores/agentStore': {
        getAgent: async (id) => { touched.push({ what: 'getAgent', args: [id] }); return { ...AGENT }; },
        listConversations: note('listConversations'),
        createConversation: async (...a) => { touched.push({ what: 'createConversation', args: a }); return { id: 'c9' }; },
        getConversationById: async (id) => { touched.push({ what: 'getConversationById', args: [id] }); return { ...CONVERSATION }; },
        updateConversationTitle: note('updateConversationTitle'),
        pinConversation: note('pinConversation'),
        setConversationLabels: note('setConversationLabels'),
        updateThreadTitles: note('updateThreadTitles'),
        updateConversationWorkspace: note('updateConversationWorkspace'),
        deleteConversationById: note('deleteConversationById'),
    },
    '../../core/agentRuntime': {},
    '../../core/aiAgent': {},
    '../../stores/configStore': {},
    '../../auth': {},
    '../../stores/memoryStore': {},
    '../../utils/routeHelpers': { getEffectiveUserId: (req) => req.session?.user?.id || null },
    '../../stores/userStore': {},
    '../../stores/usageStore': {},
    '../../core/entitlements/limits': {},
    '../../core/http/sseHelpers': {},
    './crud': { canReadAgent: async () => true },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:agent-conversations-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]conversations\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./conversations');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
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

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
}

// ═══ POST /:id/conversations ════════════════════════════════════════

test('a numeric title is refused by name instead of reaching the store as a number', async () => {
    await refuses({ method: 'POST', url: '/a1/conversations', body: { title: 42 } }, 'body.title');
});

test('a key the route does not read is refused rather than answered with 200', async () => {
    await refuses({ method: 'POST', url: '/a1/conversations', body: { titel: 'Nieuw' } }, 'body');
});

// ═══ PATCH /:id/conversations/:convId ═══════════════════════════════

test('a pin that is not a boolean is refused by name', async () => {
    // `pinned: 0` used to unpin and `pinned: 2` to pin, because the check
    // also accepted a number and the store coerced it with `!!`.
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1', body: { pinned: 0 } }, 'body.pinned');
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1', body: { pinned: 'yes' } }, 'body.pinned');
});

test('labels must be a list of text, and the bad entry is named by index', async () => {
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1', body: { labels: 'work' } }, 'body.labels');
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1', body: { labels: ['ok', 7] } }, 'body.labels.1');
});

test('a title over the cap is refused in words that give the cap', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/conversations/c1', body: { title: 'x'.repeat(501) } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A conversation title is at most 500 characters.');
    assert.deepStrictEqual(touched, []);
});

test('a patch that is accepted writes exactly the fields it carried', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/conversations/c1', body: { pinned: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.filter(t => t.what !== 'getConversationById').map(t => t.what), ['pinConversation']);
});

// ═══ PATCH /:id/conversations/:convId/thread-titles ═════════════════

test('thread titles must be a map, not a list', async () => {
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1/thread-titles', body: { threadTitles: ['a'] } }, 'body.threadTitles');
});

test('a thread title that is not text is named by its thread id', async () => {
    await refuses({ method: 'PATCH', url: '/a1/conversations/c1/thread-titles', body: { threadTitles: { t1: 7 } } }, 'body.threadTitles.t1');
});

test('leaving threadTitles out is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/a1/conversations/c1/thread-titles', body: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'threadTitles maps a thread id to its title.');
});

// ═══ PUT /:id/conversations/:convId/workspace ═══════════════════════

test('workspace content that is not text is refused by name, before the write', async () => {
    await refuses({ method: 'PUT', url: '/a1/conversations/c1/workspace', body: { content: 42 } }, 'body.content');
});

test('an absent workspace body clears the content rather than refusing', async () => {
    const res = await dispatch({ method: 'PUT', url: '/a1/conversations/c1/workspace', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find(t => t.what === 'updateConversationWorkspace').args, ['c1', '', null]);
});
