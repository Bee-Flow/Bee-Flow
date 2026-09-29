/**
 * What the GitHub PAT connect route accepts, and what it says when it refuses
 * (routes/integrations/github.js).
 *
 * `!token?.trim()` guards a MISSING token but not a token of the wrong type:
 * optional chaining stops at null and undefined, so `{ token: 12345 }` called
 * `.trim()` on a number and threw a TypeError outside the try — a bare 500
 * from a route whose every other answer is a sentence. `{ tokn: 'ghp_…' }`
 * was answered "Token is required", naming the key the route wanted instead
 * of the one it got.
 *
 * Run: cd server && node --test routes/integrations/github.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every credential write lands in `touched`. A refused request must leave it empty.
const touched = [];

// The token probe is a bare fetch() in the route.
const originalFetch = global.fetch;
global.fetch = async (url) => {
    touched.push({ what: 'fetch', args: [String(url)] });
    return { ok: true, json: async () => ({ login: 'octocat' }) };
};
test.after(() => { global.fetch = originalFetch; });

const MOCKS = {
    '../../stores/configStore': {
        getSecret: async () => null,
        getConfig: async () => null,
        setSecret: async (k, v) => { touched.push({ what: 'setSecret', args: [k, v] }); },
        setConfig: async (k, v) => { touched.push({ what: 'setConfig', args: [k, v] }); },
        deleteConfig: async (k) => { touched.push({ what: 'deleteConfig', args: [k] }); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-github-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]github\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./github');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {}, session = { user: { id: 'u1' }, isAuthenticated: true } }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
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
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

test('a token of the wrong JSON type is refused in words, not with a 500', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: { token: 12345 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A GitHub personal access token is required.');
    assert.ok(res.body.details.some((d) => d.path === 'body.token'));
    assert.deepStrictEqual(touched, [], 'nothing was probed and nothing was stored');
});

test('a misspelled key is refused by name, instead of being reported as missing', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: { tokn: 'ghp_abc' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /tokn/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a blank token is still refused, in a sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: { token: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A GitHub personal access token is required.');
    assert.deepStrictEqual(touched, []);
});

test('a token is trimmed once, by the schema, on its way to the vault', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: { token: '  ghp_abc  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'setSecret').args[1], 'ghp_abc');
});

test('an unauthenticated caller still reads 401, not a 400 about its body', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: { token: 12345 }, session: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});
