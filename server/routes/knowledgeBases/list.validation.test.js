/**
 * What the knowledge-base lists accept, and what they say when they refuse
 * (routes/knowledgeBases/list.js).
 *
 * `?context=` is how a picker asks for the bases allowed on its surface, and
 * the parser behind it (listFilterFromQuery in ./shared) reads anything it
 * does not recognise as "no filter". A typo in the value or in the key handed
 * the agent picker every base, including the ones switched off for agents;
 * the same key twice was a 500. The real shared.js runs here, so what is
 * pinned is what reaches the store:
 *
 *   - the 400 NAMES the parameter (`query.context`), in a sentence;
 *   - a refused request never lists anything;
 *   - every query the pickers and the Agent Hub send today still works,
 *     cache-buster included.
 *
 * Run: cd server && node --test routes/knowledgeBases/list.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every listing lands in `touched`, with the filter it was given.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../../stores/knowledgeBases': {
        listKBs: async (userId, orgIds, opts) => { touched.push({ what: 'listKBs', args: [opts] }); return [{ id: 'kb1', is_published: true }]; },
        filterByGroupAccess: (kbs) => kbs,
    },
    '../../auth': {
        requireAuth: pass,
        resolveUserOrgIds: async () => new Set(['org1']),
        hasPermission: async () => false,
        resolveUserGroups: async () => [],
    },
    '../../core/entitlements/betaFeatures': { userHasBetaFeature: async () => false },
    '../../core/kb/kbIngestionHelpers': {},
    '../../utils/ssrfGuard': {},
    '../../core/kb/fetchGuard': { guardedFetch: async () => null },
    '../../support/kbAccess': { canAccessKB: async () => true, resolveIsOrgAdmin: async () => false },
    '../../core/kb/sources/ensureSource': { ensureKbSource: async () => null },
    '../../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:kb-list-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // The real shared.js, so the filter under test is the one production uses.
    if (parent && /knowledgeBases[\\/](list|shared)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./list');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

/**
 * Express 5's default ("simple") query parser is node's querystring: a key
 * given twice arrives as an array, so the harness builds the query the same way.
 */
function dispatch(url) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = { ...require('node:querystring').parse(search) };
        const req = {
            method: 'GET', url, originalUrl: url, path: pathname, body: undefined, query, headers: {},
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
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named parameter is in `details`, nothing listed. */
async function refuses(url, field) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 400, url);
    assert.strictEqual(res.body.code, 'invalid_request', url);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not list anything');
    return res;
}

/** The filter the store was asked for. */
async function filterFor(url) {
    const res = await dispatch(url);
    assert.strictEqual(res.statusCode, 200, `${url} → ${JSON.stringify(res.body)}`);
    const { sourceKind, usageContext, excludeContext } = touched[0].args[0];
    return { sourceKind, usageContext, excludeContext };
}

// ── What used to fall back to "every base" ──────────────────────────

test('a misspelled context is refused, not read as "no filter"', async () => {
    const res = await refuses('/?context=agnet', 'query.context');
    assert.strictEqual(res.body.error, 'context is one of: agent, direct_chat, ai_step, webpage.');
});

test('a misspelled key is refused rather than dropped', async () => {
    await refuses('/?contxt=agent', 'query');
});

test('the same key twice is a 400 that names it, not a 500 from .trim()', async () => {
    await refuses('/?context=agent&context=ai_step', 'query.context');
});

test('an excludeContext that is not a surface is refused', async () => {
    await refuses('/?excludeContext=webpag', 'query.excludeContext');
});

test('includeAuto that is neither yes nor no is refused', async () => {
    await refuses('/?includeAuto=yes', 'query.includeAuto');
});

test('the published list refuses the same way', async () => {
    await refuses('/published?context=agnet', 'query.context');
});

// ── What the callers send today ─────────────────────────────────────

test('?context=agent narrows to the agent surface, manual bases only', async () => {
    assert.deepStrictEqual(await filterFor('/?context=agent'),
        { sourceKind: 'manual', usageContext: 'agent', excludeContext: null });
});

test('the Agent Hub\'s own call, cache-buster and all, still works', async () => {
    assert.deepStrictEqual(await filterFor(`/?excludeContext=webpage&t=${Date.now()}`),
        { sourceKind: 'manual', usageContext: null, excludeContext: 'webpage' });
});

test('no query at all is the unfiltered manual list', async () => {
    assert.deepStrictEqual(await filterFor('/'),
        { sourceKind: 'manual', usageContext: null, excludeContext: null });
});

test('an empty or padded context reads the way it always did', async () => {
    assert.strictEqual((await filterFor('/?context=')).usageContext, null);
    touched.length = 0;
    assert.strictEqual((await filterFor('/?context=%20ai_step%20')).usageContext, 'ai_step');
});

test('includeAuto=true includes auto-created bases, as 1 always did', async () => {
    // It used to compare against '1' only, so "true" meant "no".
    assert.strictEqual((await filterFor('/?includeAuto=true')).sourceKind, null);
    touched.length = 0;
    assert.strictEqual((await filterFor('/?includeAuto=1')).sourceKind, null);
    touched.length = 0;
    assert.strictEqual((await filterFor('/?includeAuto=0')).sourceKind, 'manual');
    touched.length = 0;
    assert.strictEqual((await filterFor('/?includeAuto=')).sourceKind, 'manual', 'empty is absent, as before');
});
