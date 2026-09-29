/**
 * GET /:type builds a report the PageRenderer can show. The agent-performance
 * report returned `title: title` with no such binding, so the admin page got a
 * 500 for every request.
 *
 * Run: cd server && node --test --test-force-exit routes/reports.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('../stores/agentStore', {
    getAgents: async () => [],
    getAllAgents: async () => [
        { id: 'a1', name: 'Support', model: 'tier:fast' },
        { id: 'a2', name: 'Sales', model: 'tier:smart' },
    ],
    getAgentStats: async (id) => ({ conversationCount: id === 'a1' ? 2 : 5, messageCount: id === 'a1' ? 10 : 40, lastUpdated: '2026-09-01' }),
    getAgentTools: async () => [],
});
stub('../stores/memoryStore', { getStats: async () => ({}) });
stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
});

const router = require('./reports');

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, originalUrl: url, query: {}, headers: {}, body: {},
            session: { isAuthenticated: true, user: { id: 'admin' } },
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200, body: undefined,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
            setHeader() {},
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${url}`)));
    });
}

test('the agent-performance report renders with its title and rows sorted by messages', async () => {
    const res = await dispatch('/agent-performance');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'Agent Performance');
    const table = res.body.layout.find((b) => b.type === 'table');
    assert.ok(table, 'the report carries a table block');
    assert.deepStrictEqual(table.data.map((r) => r.name), ['Sales', 'Support']);
});

test('an unknown report type is a 404', async () => {
    const res = await dispatch('/nope');
    assert.strictEqual(res.statusCode, 404);
});
