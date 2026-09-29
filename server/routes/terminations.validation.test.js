/**
 * Who may read the termination monitor, what its routes accept, and what they
 * say when they refuse (routes/terminations.js).
 *
 * The generic routes checked only for a session, under a mount gate that is a
 * licence capability every member of an entitled organisation holds: any
 * member read the organisation's termination log. They now ask for
 * `admin_monitoring`, as the admin console's Monitoring tab does; /org/* keeps
 * its org-admin role check.
 *
 * Each filter used to be read on its own and dropped when it did not parse,
 * and on a monitor a dropped filter is a WIDER answer under the narrow
 * heading: `?days=week` returned all time, `?agnet=` every agent, `?type=`
 * with a type the store never writes an empty list. And the other way round:
 * both screens ask for "All" by sending no range, which used to mean the last
 * 30 days. What this file pins:
 *
 *   - the 400 NAMES the field (`query.days`), not just "invalid request";
 *   - the message is a sentence;
 *   - the store is never reached, so a refused request reads nothing;
 *   - no range is all time, and the ranges the screens send still narrow.
 *
 * Run: cd server && node --test routes/terminations.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];
// Who holds `admin_monitoring`, and which org role each user has.
const fx = { monitoring: new Set(['u1']), orgRole: { u1: 'org_admin' } };

const MOCKS = {
    '../stores/terminationStore': {
        getList: async (filters, limit) => { touched.push({ what: 'getList', filters, limit }); return []; },
        getSummary: async (filters) => { touched.push({ what: 'getSummary', filters }); return { total: 0, by_type: {} }; },
        getTimeline: async (filters, interval) => { touched.push({ what: 'getTimeline', filters, interval }); return []; },
        getByAgent: async (filters) => { touched.push({ what: 'getByAgent', filters }); return []; },
    },
    '../auth': {
        resolveUserOrgIds: async () => new Set(['org-1']),
        isOrgAdminRole: (role) => role === 'org_admin',
        // The decision lines of the real requirePermission (auth/permissions.js).
        requirePermission: (permission) => (req, res, next) => {
            if (!req.session?.isAuthenticated || !req.session.user) return res.status(401).json({ error: 'Not authenticated' });
            if (permission === 'admin_monitoring' && fx.monitoring.has(req.session.user.id)) return next();
            return res.status(403).json({ error: `Permission '${permission}' required` });
        },
    },
    '../stores/userStore': { getUser: async (id) => ({ id, orgRole: fx.orgRole[id] || 'member' }) },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:terminations-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]terminations\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./terminations');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

const SIGNED_IN = { isAuthenticated: true, user: { id: 'u1' } };

function dispatch(url, session = SIGNED_IN) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: undefined, headers: {},
            session, get() { return undefined; },
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

test.beforeEach(() => {
    touched.length = 0;
    fx.monitoring = new Set(['u1']);
    fx.orgRole = { u1: 'org_admin' };
});

async function refuses(url, field) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 400, `${url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ Filters that used to widen the answer ══════════════════════════

test('a range that is not a number of days is refused, not answered with all time', async () => {
    const res = await refuses('/?days=week', 'query.days');
    assert.strictEqual(res.body.error, 'days is a whole number of days (1 or more), or "all".');
    await refuses('/summary?days=0', 'query.days');
    await refuses('/org/summary?days=-7', 'query.days');
});

test('a misspelled filter is refused, not dropped into every agent', async () => {
    await refuses('/?agnet=agent-1', 'query');
});

test('a type the store never writes is refused, not answered with an empty list', async () => {
    const res = await refuses('/?type=timeout', 'query.type');
    assert.strictEqual(res.body.error, 'type is one of: max_tokens, max_iterations, error, aborted.');
});

test('an interval the timeline does not draw is refused, not drawn per day', async () => {
    await refuses('/timeline?interval=hours', 'query.interval');
});

test('a start that is not a date is refused in words, not a 500 from Postgres', async () => {
    const res = await refuses('/org?startDate=yesterday', 'query.startDate');
    assert.match(res.body.error, /^startDate is a date/);
});

// ═══ "All" is all ════════════════════════════════════════════════════

test('no range at all — how both screens ask for "All" — is all time, not the last 30 days', async () => {
    const res = await dispatch('/summary');
    assert.strictEqual(res.statusCode, 200);
    const { filters } = touched.find((t) => t.what === 'getSummary');
    assert.strictEqual(filters.startDate, undefined);
    assert.strictEqual(filters.endDate, undefined);
    assert.strictEqual(filters.organizationId, 'org-1', 'the org scope still applies');
});

test('days=all still means all', async () => {
    const res = await dispatch('/?days=all');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].filters.startDate, undefined);
});

// ═══ What the screens send still narrows ════════════════════════════

test('?days=7 is the last seven days', async () => {
    const res = await dispatch('/by-agent?days=7');
    assert.strictEqual(res.statusCode, 200);
    const { filters } = touched[0];
    const span = new Date(filters.endDate) - new Date(filters.startDate);
    assert.strictEqual(Math.round(span / 86400000), 7);
});

test('the org panel\'s explicit window, interval and page size still arrive', async () => {
    const start = '2026-09-01T00:00:00.000Z';
    const end = '2026-09-22T00:00:00.000Z';
    const tl = await dispatch(`/org/timeline?startDate=${encodeURIComponent(start)}&endDate=${encodeURIComponent(end)}&interval=hour`);
    assert.strictEqual(tl.statusCode, 200);
    assert.strictEqual(touched[0].interval, 'hour');
    assert.deepStrictEqual(touched[0].filters, { startDate: start, endDate: end, organizationId: 'org-1' });
    touched.length = 0;
    const list = await dispatch('/org?days=30&limit=200');
    assert.strictEqual(list.statusCode, 200);
    assert.strictEqual(touched[0].limit, 200);
});

test('a caller without a session still hears 401 first, whatever the query says', async () => {
    const res = await dispatch('/?days=week', null);
    assert.strictEqual(res.statusCode, 401);
    const org = await dispatch('/org?days=week', null);
    assert.strictEqual(org.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});

// ═══ Who may read the organisation's terminations ═══════════════════

const MEMBER = { isAuthenticated: true, user: { id: 'u2' } };

test('a plain member cannot read the org\'s termination log through the generic routes', async () => {
    for (const url of ['/?days=30', '/summary', '/timeline', '/by-agent']) {
        const res = await dispatch(url, MEMBER);
        assert.strictEqual(res.statusCode, 403, `${url} -> ${JSON.stringify(res.body)}`);
        assert.deepStrictEqual(res.body, { error: "Permission 'admin_monitoring' required" });
    }
    assert.deepStrictEqual(touched, [], 'no colleague\'s row was read');
});

test('the permission is asked before the query is judged', async () => {
    const res = await dispatch('/?days=week', MEMBER);
    assert.strictEqual(res.statusCode, 403);
});

test('a holder of admin_monitoring still reads the list, scoped to their organisation', async () => {
    fx.monitoring.add('u2');
    const res = await dispatch('/?days=30', MEMBER);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].filters.organizationId, 'org-1');
});

test('the org admin\'s own view is unchanged: the org-admin role, not the permission', async () => {
    fx.monitoring = new Set();
    const admin = await dispatch('/org/summary');
    assert.strictEqual(admin.statusCode, 200, 'an org admin without admin_monitoring still has /org');
    touched.length = 0;
    const member = await dispatch('/org/summary', MEMBER);
    assert.strictEqual(member.statusCode, 403);
    assert.deepStrictEqual(touched, []);
});
