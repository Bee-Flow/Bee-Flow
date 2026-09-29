/**
 * What the deploy pipeline may send to the maintenance routes, and what they
 * say when they refuse (routes/maintenance.js).
 *
 * Whatever /announce stores is shown in a banner in front of every signed-in
 * user. `reason: {}` went through String() and put "[object Object]" there; a
 * misspelled `reson` or `rfe` was dropped without a word; and a failure while
 * storing the window answered 500 with the raw error message. What this file
 * pins:
 *
 *   - the body a deploy pipeline sends (`{ etaSeconds, reason, ref }`) still works;
 *   - anything else is a 400 in a sentence, and nothing is announced;
 *   - the token gate still answers first;
 *   - a store failure is a generic 500, not an echo.
 *
 * Run: cd server && node --test routes/maintenance.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const TOKEN = 'test-deploy-token';
process.env.MAINTENANCE_ANNOUNCE_TOKEN = TOKEN;

// Every window change lands in `touched`. A refused request must leave it empty.
const touched = [];
const fx = { announceError: null };

const MOCKS = {
    '../core/entitlements/maintenanceWindow': {
        getActiveWindow: async () => null,
        announce: async (opts) => {
            if (fx.announceError) throw fx.announceError;
            touched.push({ what: 'announce', args: [opts] });
            return { etaSeconds: 120, ...opts };
        },
        clear: async () => { touched.push({ what: 'clear', args: [] }); },
    },
    '../utils/buildInfo': { APP_BUILD_SHA: 'sha-test' },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:maintenance-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]maintenance\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./maintenance');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body, token = TOKEN }) {
    return new Promise((resolve, reject) => {
        const headers = token ? { authorization: `Bearer ${token}` } : {};
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers,
            session: {}, get(name) { return headers[String(name).toLowerCase()]; },
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

const announce = (body, opts = {}) => dispatch({ method: 'POST', url: '/announce', body, ...opts });
const ETA_TEXT = 'etaSeconds is the expected outage in seconds, as a number.';

test.beforeEach(() => { touched.length = 0; fx.announceError = null; });

test('the body the deploy pipeline sends is announced as sent', async () => {
    const res = await announce({ etaSeconds: 300, reason: 'Deploying an update', ref: 'deadbeef' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'announce', args: [{ etaSeconds: 300, reason: 'Deploying an update', ref: 'deadbeef' }] }]);
});

test('a numeric string is still an ETA, as the core documents', async () => {
    const res = await announce({ etaSeconds: '180' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched[0].args[0].etaSeconds, '180', 'the core clamps it, as before');
});

test('an ETA that is not a number is refused in a sentence', async () => {
    for (const etaSeconds of ['soon', '', ' ', null, true, [60]]) {
        const res = await announce({ etaSeconds });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(etaSeconds));
        assert.strictEqual(res.body.error, ETA_TEXT);
    }
    assert.deepStrictEqual(touched, []);
});

test('a missing ETA gets the same sentence, not "Required"', async () => {
    const res = await announce({ reason: 'Deploying an update' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, ETA_TEXT);
    assert.ok(res.body.details.some((d) => d.path === 'body.etaSeconds'));
    assert.deepStrictEqual(touched, []);
});

test('a reason that is not text is refused, instead of "[object Object]" in the banner', async () => {
    const res = await announce({ etaSeconds: 120, reason: {} });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'reason is the text the banner shows.');
    assert.deepStrictEqual(touched, []);
});

test('a misspelled key is refused by name, instead of dropped from the banner', async () => {
    const res = await announce({ etaSeconds: 120, reson: 'Deploying an update' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/reson/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('the token gate still answers before the schema', async () => {
    const res = await announce({ etaSeconds: 'soon' }, { token: null });
    assert.strictEqual(res.statusCode, 401);
});

test('a failure while storing the window is a generic 500, not an echo of its message', async () => {
    fx.announceError = new Error('connect ECONNREFUSED 10.0.0.5:5432');
    const res = await announce({ etaSeconds: 120 });
    assert.strictEqual(res.statusCode, 500);
    assert.ok(!/ECONNREFUSED/.test(JSON.stringify(res.body)), `nothing internal leaks: ${JSON.stringify(res.body)}`);
});

test('clear takes no body, and still clears without one', async () => {
    const refused = await dispatch({ method: 'POST', url: '/clear', body: { force: true } });
    assert.strictEqual(refused.statusCode, 400);
    assert.deepStrictEqual(touched, []);
    const res = await dispatch({ method: 'POST', url: '/clear', body: undefined });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched, [{ what: 'clear', args: [] }]);
});
