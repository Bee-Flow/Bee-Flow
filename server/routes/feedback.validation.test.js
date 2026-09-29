/**
 * What the feedback routes accept, and what they say when they refuse
 * (routes/feedback.js).
 *
 * The reads are filters over other people's feedback, and a dropped filter is
 * not "no filter" to the person asking:
 *
 *   - `?raitng=down` answered with EVERY rating to someone looking for the
 *     complaints; `?rating=Down` with none at all, which reads as "nobody
 *     complained";
 *   - `/org?limit=` reached SQL unclamped — and `?limit=abc` as NaN, a 500;
 *   - a date the database could not parse was a 500 as well.
 *
 * On the POST, a `source` other than 'agent' or 'direct' was stored as a third
 * word no dashboard tab groups on. And a rating without a `messageId` was
 * filed under the conversation's one `…_none_…` row, so rating a second answer
 * REPLACED the rating of the first (the store upserts on that id).
 *
 * What this file pins:
 *
 *   - the 400 NAMES the field (`query.rating`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the store is never reached, so a refused request reads and writes nothing.
 *
 * Run: cd server && node --test routes/feedback.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/feedbackStore': {
        saveFeedback: async (row) => { touched.push({ what: 'saveFeedback', args: [row] }); return { id: 'fb-1' }; },
        getFeedback: async (filters, limit) => { touched.push({ what: 'getFeedback', args: [filters, limit] }); return []; },
        getFeedbackSummary: async (filters) => { touched.push({ what: 'getFeedbackSummary', args: [filters] }); return { total: 0 }; },
    },
    '../auth/permissions': {
        requireAuth: pass,
        requireSuperAdmin: pass,
        resolveUserOrgIds: async () => new Set(['org-1']),
        isOrgAdminRole: () => true,
    },
    '../stores/userStore': { getUser: async () => ({ id: 'u1', orgRole: 'org_admin' }) },
    '../db': { getAll: async () => [] },
    '../core/entitlements/entitlements': { requireCapability: () => pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:feedback-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]feedback\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./feedback');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = url.split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, body, query, headers: {},
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

test('a misspelled rating filter is refused, instead of answering with every rating', async () => {
    for (const url of ['/?raitng=down', '/org?raitng=down']) {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 400, url);
    }
    assert.deepStrictEqual(touched, []);
});

test('?rating=Down is refused in words, instead of an empty list that reads as "nobody complained"', async () => {
    const res = await dispatch({ method: 'GET', url: '/org?rating=Down' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'rating must be "up" or "down"');
    assert.ok(res.body.details.some((d) => d.path === 'query.rating'));
    assert.deepStrictEqual(touched, []);
});

test('/org clamps its page size like the global list, and refuses one that is not a number', async () => {
    let res = await dispatch({ method: 'GET', url: '/org?limit=100000' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[1], 500, 'the same cap as GET /');

    touched.length = 0;
    res = await dispatch({ method: 'GET', url: '/org?limit=abc' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query.limit'));
    assert.deepStrictEqual(touched, [], 'NaN never reaches the SQL LIMIT');
});

test('a date the database cannot read is refused; one it can is handed over as ISO text', async () => {
    let res = await dispatch({ method: 'GET', url: '/org/summary?startDate=last-week' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'startDate is a date, like 2026-09-01T00:00:00Z.');
    assert.deepStrictEqual(touched, []);

    res = await dispatch({ method: 'GET', url: '/summary?startDate=2026-09-01&endDate=2026-09-22T12:00:00Z' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched[0].args[0], { startDate: '2026-09-01T00:00:00.000Z', endDate: '2026-09-22T12:00:00.000Z' });
});

test('the admin dashboards\' own query strings still read', async () => {
    const qs = 'startDate=2026-08-23T00:00:00.000Z&endDate=2026-09-22T00:00:00.000Z';
    for (const url of [`/?${qs}`, `/summary?${qs}`, `/org?${qs}`, `/org/summary?${qs}`]) {
        const res = await dispatch({ method: 'GET', url });
        assert.strictEqual(res.statusCode, 200, url);
    }
});

test('a rating with an unknown source is refused rather than filed under a heading no tab shows', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { rating: 'up', messageId: 'm1', source: 'Direct' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'source is "agent" or "direct".');
    assert.deepStrictEqual(touched, []);
});

test('a rating without the message it rates is refused — the next one would have overwritten it', async () => {
    for (const body of [
        { conversationId: 'c1', rating: 'up' },
        { conversationId: 'c1', messageId: null, rating: 'down' },
        { conversationId: 'c1', messageId: '   ', rating: 'down' },
    ]) {
        const res = await dispatch({ method: 'POST', url: '/', body });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(body));
        assert.strictEqual(res.body.error, 'Say which message the rating is for (messageId).');
        assert.ok(res.body.details.some((d) => d.path === 'body.messageId'));
    }
    const typo = await dispatch({ method: 'POST', url: '/', body: { conversationId: 'c1', messageID: 'm2', rating: 'down' } });
    assert.strictEqual(typo.statusCode, 400, 'a misspelled messageId is refused too');
    assert.deepStrictEqual(touched, [], 'no rating was written over another');
});

test('two ratings in one conversation reach the store as two messages', async () => {
    await dispatch({ method: 'POST', url: '/', body: { conversationId: 'c1', messageId: 'm1', rating: 'up' } });
    await dispatch({ method: 'POST', url: '/', body: { conversationId: 'c1', messageId: 42, rating: 'down' } });
    const ids = touched.filter((t) => t.what === 'saveFeedback').map((t) => t.args[0].messageId);
    assert.deepStrictEqual(ids, ['m1', '42'], 'a numeric message id is kept, as text');
});

test('a rating left out is refused in words, not with "Required"', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { messageId: 'm1' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'rating must be "up" or "down"');
    assert.ok(res.body.details.some((d) => d.path === 'body.rating'));
    assert.deepStrictEqual(touched, []);
});

test('a snapshot that is not a list of messages is refused', async () => {
    const res = await dispatch({ method: 'POST', url: '/', body: { messageId: 'm1', rating: 'down', conversationSnapshot: 'the whole chat' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.conversationSnapshot'));
    assert.deepStrictEqual(touched, []);
});

test('the web chat\'s rating, snapshot and all, is saved as sent', async () => {
    const body = {
        conversationId: 'c1', messageId: 'm7', agentId: 'a1', agentName: 'Helper',
        model: 'claude-x', modelTier: null, rating: 'down', comment: 'Wrong year',
        source: 'direct',
        conversationSnapshot: [{ id: 'm6', role: 'user', content: 'When?', timestamp: 1, model: null }],
    };
    const res = await dispatch({ method: 'POST', url: '/', body });
    assert.strictEqual(res.statusCode, 200);
    const row = touched.find((t) => t.what === 'saveFeedback').args[0];
    assert.strictEqual(row.source, 'direct');
    assert.strictEqual(row.comment, 'Wrong year');
    assert.deepStrictEqual(row.conversationSnapshot, body.conversationSnapshot);
});

test('the phone\'s rating — no model, no comment — is saved with the defaults filled server-side', async () => {
    const res = await dispatch({
        method: 'POST', url: '/',
        body: { conversationId: null, messageId: 'm1', agentId: null, agentName: null, rating: 'up', source: 'agent' },
    });
    assert.strictEqual(res.statusCode, 200);
    const row = touched.find((t) => t.what === 'saveFeedback').args[0];
    assert.strictEqual(row.rating, 'up');
    assert.strictEqual(row.conversationSnapshot, null);
});
