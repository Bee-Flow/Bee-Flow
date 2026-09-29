/**
 * What the LinkedIn post route accepts, and what it says when it refuses
 * (routes/integrations/linkedin.js).
 *
 * Posting is irreversible from here, and `!text?.trim()` guarded a missing
 * post but not a post of the wrong type: optional chaining stops at null and
 * undefined, so `{ text: 12345 }` called `.trim()` on a number and threw a
 * TypeError OUTSIDE the try below — a bare 500 on a route whose every other
 * failure is a sentence the draft card renders.
 *
 * Run: cd server && node --test routes/integrations/linkedin.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every outbound post lands in `touched`. A refused request must leave it empty.
const touched = [];

const originalFetch = global.fetch;
global.fetch = async (url, init) => {
    touched.push({ what: 'fetch', args: [String(url), init && init.body] });
    return { ok: true, status: 201, text: async () => '' };
};
test.after(() => { global.fetch = originalFetch; });

const MOCKS = {
    '../../stores/configStore': {
        getSecret: async () => 'li_token',
        getConfig: async () => 'person_1',
        setSecret: async () => {},
        setConfig: async () => {},
        deleteConfig: async () => {},
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:integrations-linkedin-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /integrations[\\/]linkedin\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./linkedin');
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

test('post text of the wrong JSON type is refused in words, not with a 500', async () => {
    const res = await dispatch({ method: 'POST', url: '/post', body: { text: 12345 } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A LinkedIn post needs text.');
    assert.ok(res.body.details.some((d) => d.path === 'body.text'));
    assert.deepStrictEqual(touched, [], 'nothing was posted');
});

test('a misspelled key is refused by name, instead of being reported as missing', async () => {
    const res = await dispatch({ method: 'POST', url: '/post', body: { txt: 'Hello LinkedIn' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => /txt/.test(d.message)),
        `the refusal names the key it did not expect: ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, []);
});

test('a blank post is still refused, in a sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/post', body: { text: '   ' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'A LinkedIn post needs text.');
    assert.deepStrictEqual(touched, []);
});

test("the draft card's body still reaches LinkedIn, trimmed once", async () => {
    const res = await dispatch({ method: 'POST', url: '/post', body: { text: '  Shipping today.  ' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(JSON.parse(touched[0].args[1]).commentary, 'Shipping today.');
});

test('an unauthenticated caller still reads 401, not a 400 about its body', async () => {
    const res = await dispatch({ method: 'POST', url: '/post', body: { text: 12345 }, session: {} });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(touched, []);
});
