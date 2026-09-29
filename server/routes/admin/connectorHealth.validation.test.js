'use strict';

/**
 * What the connector-health list routes accept, and what they say when they
 * refuse (routes/admin/connectorHealth.js).
 *
 * Both narrow on a value the store matches exactly, and both used to take
 * whatever arrived. `?severity=warn` — the store writes 'warning' — matched
 * no row, so the timeline answered an empty list, which an operator reads as
 * "nothing happened at that level". `?includeResolved=yes` was neither '1'
 * nor 'true', so the resolved problems the caller asked for were left out,
 * under a 200. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`query.severity`), not just "invalid request";
 *   - the message is a sentence, and lists the values;
 *   - the store is never reached, so a refused request reads nothing.
 *
 * Run: cd server && node --test routes/admin/connectorHealth.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every store read lands in `touched`. A refused request must leave it empty.
const touched = [];

mock(path.join(SERVER, 'stores/orgHealthStore'), {
    listProblems: async (p) => { touched.push({ what: 'listProblems', args: [p] }); return []; },
    listEvents: async (p) => { touched.push({ what: 'listEvents', args: [p] }); return { events: [], nextCursor: null }; },
    getFleetOverview: async () => ({ orgs: [], orphans: [] }),
    getOrgHealth: async () => ({}),
});
mock(path.join(SERVER, 'stores/userStore'), {
    getOrganization: async (id) => ({ id }),
    getAllUsers: async () => [],
});
mock(path.join(SERVER, 'auth/permissions'), {
    requireAuth: (req, res, next) => next(),
    requireSuperAdmin: (req, res, next) => next(),
    isOrgAdminForOrg: async () => true,
    resolveUserOrgIds: async () => new Set(['org1']),
});
mock(path.join(SERVER, 'auth/gateMeta'), { tagGate: (fn) => fn });

const router = require('./connectorHealth');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
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

async function refuses(request, field) {
    const res = await dispatch(request);
    assert.strictEqual(res.statusCode, 400, `${request.url} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ GET /:orgId/events ═════════════════════════════════════════════

test('a severity the store never writes is refused, not answered with an empty timeline', async () => {
    const res = await refuses({ method: 'GET', url: '/admin/connector-health/org1/events?severity=warn' }, 'query.severity');
    assert.strictEqual(res.body.error, 'severity is one of: info, warning, error, critical.');
});

test('a misspelled filter is refused, not dropped into a wider list', async () => {
    await refuses({ method: 'GET', url: '/admin/connector-health/org1/events?serverity=error' }, 'query');
});

test('a limit that is not a number is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/admin/connector-health/org1/events?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('the filters the timeline offers still narrow', async () => {
    const res = await dispatch({ method: 'GET', url: '/admin/connector-health/org1/events?severity=error&limit=50' });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'listEvents').args[0];
    assert.strictEqual(args.severity, 'error');
    assert.strictEqual(args.limit, 50);
});

// ═══ GET /:orgId/problems ═══════════════════════════════════════════

test('a truthy word that is not a flag is refused, not read as "leave them out"', async () => {
    const res = await refuses({ method: 'GET', url: '/admin/connector-health/org1/problems?includeResolved=yes' }, 'query.includeResolved');
    assert.strictEqual(res.body.error, 'includeResolved is "1", "0", "true" or "false".');
});

test('the flag the route documents still switches the resolved rows on', async () => {
    const res = await dispatch({ method: 'GET', url: '/admin/connector-health/org1/problems?includeResolved=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listProblems').args[0].includeResolved, true);
});
