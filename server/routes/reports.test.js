/**
 * GET /:type builds a report the PageRenderer can show, about the caller's
 * organisations and no other.
 *
 * The agent-performance report returned `title: title` with no such binding,
 * so the admin page got a 500 for every request. And `admin_monitoring` is
 * held by every organisation admin, DPO and auditor; it says the caller may
 * read reports, not about whom. Both generators read the agent store without
 * an organisation, so one organisation's report listed every organisation's
 * agents. What this file pins:
 *
 *   super admin         → the store is asked for every organisation (null),
 *                          rows sorted by messages
 *   organisation admin  → the store is asked for THEIR organisations, and the
 *                          report carries no agent of another
 *
 * Hermetic: the stores and the scope are stubbed; the store stub narrows the
 * way the real SQL does (stores/agent/agentStats.orgScope.test.js proves the
 * SQL against a real Postgres).
 *
 * Run: cd server && node --test --test-force-exit routes/reports.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

function stub(p, exports) {
    const filename = require.resolve(p);
    require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const AGENTS = [
    { id: 'a1', name: 'Support', model: 'tier:fast', organization_id: 'org_a' },
    { id: 'a2', name: 'Sales', model: 'tier:smart', organization_id: 'org_b' },
];
// What each store read was asked to narrow to, per function name.
const asked = {};
const narrowed = (orgIds) => (orgIds === null ? AGENTS : AGENTS.filter((a) => orgIds.includes(a.organization_id)));

stub('../stores/agentStore', {
    getAgents: async () => [],
    getAllAgents: async ({ orgIds = null } = {}) => { asked.getAllAgents = orgIds; return narrowed(orgIds); },
    getAgentStats: async (id) => ({ conversationCount: id === 'a1' ? 2 : 5, messageCount: id === 'a1' ? 10 : 40, lastUpdated: '2026-09-01' }),
    getAgentTools: async () => [],
    getSystemStats: async (startDate, endDate, { orgIds = null } = {}) => {
        asked.getSystemStats = orgIds;
        const mine = narrowed(orgIds);
        return {
            totalAgents: mine.length, totalConversations: mine.length, activeConversations: 0, totalMessages: mine.length,
            agentMessageCounts: Object.fromEntries(mine.map((a) => [a.id, 1])),
        };
    },
    getAgent: async (id) => AGENTS.find((a) => a.id === id) || null,
});
stub('../stores/memoryStore', {
    getMemoryStats: async () => ({ total: 0, importanceDistribution: { high: 0 }, typeDistribution: { labels: [], data: [] } }),
});
stub('../auth/permissions', {
    requireAuth: (req, res, next) => next(),
    requirePermission: () => (req, res, next) => next(),
});
// The caller's scope; the super admin's (null) narrows nothing.
let scope = { orgIds: null, isSuperAdmin: true };
stub('../auth/orgScope', { orgScope: async () => scope });

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

const asOrgAdmin = (org) => { scope = { orgIds: new Set([org]), isSuperAdmin: false }; };
const asSuperAdmin = () => { scope = { orgIds: null, isSuperAdmin: true }; };

test('the agent-performance report renders with its title and rows sorted by messages', async () => {
    asSuperAdmin();
    const res = await dispatch('/agent-performance');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.title, 'Agent Performance');
    const table = res.body.layout.find((b) => b.type === 'table');
    assert.ok(table, 'the report carries a table block');
    assert.deepStrictEqual(table.data.map((r) => r.name), ['Sales', 'Support']);
    assert.strictEqual(asked.getAllAgents, null, 'the super admin reads every organisation');
});

test('agent-performance for an organisation admin names no agent of another organisation', async () => {
    asOrgAdmin('org_a');
    const res = await dispatch('/agent-performance');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(asked.getAllAgents, ['org_a'], 'the narrowing is asked of the store, in the SQL');
    const table = res.body.layout.find((b) => b.type === 'table');
    assert.deepStrictEqual(table.data.map((r) => r.id), ['a1']);
});

test('system-overview for an organisation admin counts and charts only their organisation', async () => {
    asOrgAdmin('org_b');
    const res = await dispatch('/system-overview');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(asked.getSystemStats, ['org_b']);
    const chart = res.body.layout.find((b) => b.type === 'chart' && b.title === 'Messages per Agent');
    assert.deepStrictEqual(chart.data.labels, ['Sales']);
    const totals = res.body.layout.find((b) => b.type === 'row').cols.find((c) => c.label === 'Total Agents');
    assert.strictEqual(totals.value, 1);
});

test('system-overview for the super admin reads every organisation, as before', async () => {
    asSuperAdmin();
    const res = await dispatch('/system-overview');
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.strictEqual(asked.getSystemStats, null);
    const totals = res.body.layout.find((b) => b.type === 'row').cols.find((c) => c.label === 'Total Agents');
    assert.strictEqual(totals.value, 2);
});

test('an unknown report type is a 404', async () => {
    const res = await dispatch('/nope');
    assert.strictEqual(res.statusCode, 404);
});
