/**
 * What the PII-guard install and uninstall routes accept, and what they say
 * when they refuse (routes/guardInstall.js).
 *
 * Both routes answer 202 and do the work in the background, so a request they
 * misread was only ever discovered afterwards, in the containers:
 * `removeVolume: "false"` is truthy and DELETED the cache volume the caller
 * asked to keep, and a misspelled `modle` installed the default model. What
 * this file pins:
 *
 *   - the 400 names the field, in a sentence;
 *   - a refused request never reaches the installer.
 *
 * Run: cd server && node --test routes/guardInstall.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every installer call lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../auth/permissions': { requirePermission: () => pass },
    '../services/guardInstaller': {
        getStatus: async () => ({ status: 'not-installed' }),
        install: (opts) => { touched.push({ what: 'install', args: [opts] }); },
        uninstall: (opts) => { touched.push({ what: 'uninstall', args: [opts] }); },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:guard-install-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]guardInstall\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./guardInstall');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'admin1' } }, get() { return undefined; },
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

test('removeVolume "false" is refused, instead of deleting the volume', async () => {
    const res = await dispatch({ method: 'POST', url: '/uninstall', body: { removeVolume: 'false' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'removeVolume is true or false.');
    assert.ok(res.body.details.some((d) => d.path === 'body.removeVolume'));
    assert.deepStrictEqual(touched, [], 'the uninstall never started');
});

test('an uninstall with no body keeps the volume, as before', async () => {
    const res = await dispatch({ method: 'POST', url: '/uninstall', body: undefined });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(touched, [{ what: 'uninstall', args: [{ removeVolume: false }] }]);
});

test('a misspelled model key is refused by name, instead of installing the default', async () => {
    const res = await dispatch({ method: 'POST', url: '/install', body: { modle: 'my-org/my-gliner' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/modle/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, []);
});

test('a misspelled apiKey is refused, instead of installing the guard with NO key', async () => {
    const res = await dispatch({ method: 'POST', url: '/install', body: { apikey: 'k3y' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(/apikey/.test(res.body.error), `the 400 names the key: ${res.body.error}`);
    assert.deepStrictEqual(touched, [], 'the installer never started, so no guard came up open');
});

test('a model id with a space in it is refused in a sentence', async () => {
    const res = await dispatch({ method: 'POST', url: '/install', body: { model: 'my org/gliner' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'model is a model id, like E3-JSI/gliner-multi-pii-domains-v1.');
    assert.deepStrictEqual(touched, []);
});

test('an install body is trimmed once, by the schema, on its way to the installer', async () => {
    const res = await dispatch({ method: 'POST', url: '/install', body: { apiKey: ' k3y\n', model: ' E3-JSI/gliner ' } });
    assert.strictEqual(res.statusCode, 202);
    assert.deepStrictEqual(touched, [{ what: 'install', args: [{ apiKey: 'k3y', model: 'E3-JSI/gliner' }] }]);
});
