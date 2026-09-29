/**
 * What GET /reports/:type accepts, and what it does with the period
 * (routes/reports.js).
 *
 * Both report types declare a Time Period filter. The agent-performance
 * generator took no filters at all, so `?startDate=…&endDate=…` returned
 * all-time numbers under the same heading; a misspelled `?startdate=` did the
 * same for every type; and a start without an end crashed the system-overview
 * title (`endDate.split`) — a 500. What this file pins:
 *
 *   - the period reaches the agent statistics and names itself in the title;
 *   - a one-sided period is a report, not a 500;
 *   - a misspelled or malformed period is a 400 that NAMES the field, and no
 *     statistics are read;
 *   - the system overview answers at all: it read its memory numbers off an
 *     un-awaited promise, a TypeError on every request, which a synchronous
 *     mock of getMemoryStats had hidden here.
 *
 * Run: cd server && node --test routes/reports.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every statistics read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../stores/agentStore': {
        getAllAgents: async () => [{ id: 'a1', name: 'Support', model: 'tier:fast' }],
        getAgentStats: async (...args) => { touched.push({ what: 'getAgentStats', args }); return { conversationCount: 1, messageCount: 4, lastUpdated: null }; },
        getAgentTools: async () => [],
        getSystemStats: async (...args) => {
            touched.push({ what: 'getSystemStats', args });
            return { totalAgents: 1, totalConversations: 1, activeConversations: 0, totalMessages: 4, agentMessageCounts: {} };
        },
        getAgent: async () => null,
    },
    // Async, like the real one (stores/memoryStore.js) — a sync mock hid that
    // the system overview never awaited it.
    '../stores/memoryStore': {
        getMemoryStats: async (userId) => {
            touched.push({ what: 'getMemoryStats', args: [userId] });
            return { total: 7, importanceDistribution: { high: 2, medium: 3, low: 2 }, typeDistribution: { labels: ['fact'], data: [7] } };
        },
    },
    '../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:reports-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]reports\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./reports');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: undefined, headers: {},
            session: { user: { id: 'admin' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('the agent-performance report counts within the period it declares, and says so', async () => {
    const res = await dispatch('/agent-performance?startDate=2026-01-01&endDate=2026-01-31');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'getAgentStats').args, ['a1', '2026-01-01', '2026-01-31']);
    assert.strictEqual(res.body.title, 'Agent Performance (2026-01-01 - 2026-01-31)');
});

test('without a period it is all time, as before', async () => {
    const res = await dispatch('/agent-performance');
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'getAgentStats').args, ['a1', null, null]);
    assert.strictEqual(res.body.title, 'Agent Performance');
});

test('a start without an end is a report, not a 500 from the title', async () => {
    const res = await dispatch('/system-overview?startDate=2026-09-01T00:00:00.000Z');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.title, 'System Overview (from 2026-09-01)');
    assert.deepStrictEqual(touched.find((t) => t.what === 'getSystemStats').args, ['2026-09-01T00:00:00.000Z', null]);
});

test('the system overview answers, with the memory numbers in it — it was a TypeError on every request', async () => {
    const res = await dispatch('/system-overview');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'System Overview');
    const stats = res.body.layout.flatMap((b) => b.cols || []).filter((c) => c.type === 'stat');
    assert.strictEqual(stats.find((c) => c.label === 'Total Memories').value, 7);
    assert.strictEqual(stats.find((c) => c.label === 'High Importance').value, 2);
    assert.deepStrictEqual(touched.find((t) => t.what === 'getMemoryStats').args, ['admin']);
});

test('a misspelled period is refused, not answered with all time', async () => {
    const res = await dispatch('/system-overview?startdate=2026-09-01');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === 'query'), JSON.stringify(res.body.details));
    assert.deepStrictEqual(touched, []);
});

test('a period that is not a date is refused in words, not a 500 from Postgres', async () => {
    const res = await dispatch('/agent-performance?startDate=yesterday&endDate=2026-09-22');
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query.startDate'), JSON.stringify(res.body.details));
    assert.match(res.body.error, /^startDate is a date/);
    assert.deepStrictEqual(touched, []);
});
