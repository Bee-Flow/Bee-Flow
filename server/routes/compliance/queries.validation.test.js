/**
 * What the compliance READ routes accept in their query, and what they say
 * when they refuse (routes/compliance/attention.js, calendar.js and
 * deadlines.js — the same `.strict()` query now guards checks.js,
 * overview.js, evidence.js, accessAudit.js, counts.js, portability.js and
 * orgUsers.js, each beside the tests those files already have).
 *
 * All of them shared one shape: a misspelled PARAMETER was not a parameter at
 * all, so the filter or the window it carried simply vanished and the route
 * answered 200 with the default — the whole list, the relevant-only calendar,
 * ninety days of score history — as if that was what had been asked for.
 * `?limt=10`, `?all=yes`, `?framwork=gdpr` and `?dais=30` all read that way.
 *
 * What this file pins is the part a caller can act on: the 400 names `query`
 * or the field in it, the message is a sentence, the store is never reached,
 * and the parameters the compliance hub really sends still work.
 *
 * Run: cd server && node --test routes/compliance/queries.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

// Every read lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../compliance/attention': {
        build: async (orgId, opts) => { touched.push({ what: 'attention', args: [orgId, opts] }); return { items: [] }; },
    },
    '../../compliance/calendar': {
        list: async (orgId, opts) => { touched.push({ what: 'calendar', args: [orgId, opts] }); return []; },
        countByFramework: () => ({}),
        invalidate: () => {},
    },
    '../../compliance/deadlines': {
        build: async (orgId) => { touched.push({ what: 'deadlines', args: [orgId] }); return { clocks: [] }; },
    },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': { resolveOrgId: async () => 'orgA', requireOrgId: async () => 'orgA' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:compliance-queries-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/](attention|calendar|deadlines)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = express.Router();
router.use(require('./attention'));
router.use(require('./calendar'));
router.use(require('./deadlines'));
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, query, body: {}, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
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
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

async function refuses(url, field) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 400, url);
    assert.strictEqual(res.body.code, 'invalid_request', url);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ GET /attention ════════════════════════════════════════════════

test('a misspelled limit key is refused, not answered with the default five rows', async () => {
    await refuses('/attention?limt=10', 'query');
});

test('a limit that is not a number is refused in words', async () => {
    const res = await refuses('/attention?limit=veel', 'query.limit');
    assert.strictEqual(res.body.error, 'limit must be a whole number of rows.');
});

test('the limit the rail asks for still reaches the builder, and no limit still means five', async () => {
    const ten = await dispatch('/attention?limit=10');
    assert.strictEqual(ten.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'attention').args[1].limit, 10);

    touched.length = 0;
    const none = await dispatch('/attention');
    assert.strictEqual(none.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'attention').args[1].limit, 5);
});

// ═══ GET /calendar ═════════════════════════════════════════════════

test('an "all" that is not a flag is refused rather than read as "only the relevant ones"', async () => {
    const res = await refuses('/calendar?all=yes', 'query.all');
    assert.strictEqual(res.body.error, 'all is one of: 1, 0, true, false.');
});

test('a misspelled calendar key is refused rather than dropped', async () => {
    await refuses('/calendar?al=1', 'query');
});

test('the "show everything" toggle still reaches the calendar', async () => {
    const res = await dispatch('/calendar?all=1');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'calendar').args[1].all, true);
});

// ═══ GET /deadlines — a route with no parameters at all ════════════

test('the deadlines route still answers without a query', async () => {
    const res = await dispatch('/deadlines');
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'deadlines'));
});

test('a parameter on a route that reads none is refused rather than silently ignored', async () => {
    await refuses('/deadlines?regulation=GDPR', 'query');
});
