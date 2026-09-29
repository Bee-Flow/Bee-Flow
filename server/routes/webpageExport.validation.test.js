/**
 * What the webpage PDF export accepts, and what it says when it fails
 * (routes/webpageExport.js).
 *
 * Two things this file pins:
 *
 *   - The render has one fixed layout, so the body is pinned empty. A caller
 *     that sends `{ format: 'A4' }` believes it is choosing the paper size; it
 *     used to get a 200 and a Letter-sized PDF. It is now refused by name,
 *     before the browser is started.
 *
 *   - A failed render is answered by the terminal error handler with a
 *     generic sentence and a correlation id. The route used to answer
 *     `'PDF generation failed: ' + err.message`, and the browser backend's
 *     message names the docker socket, the endpoint and the env vars to set.
 *
 * Run: cd server && node --test --test-force-exit routes/webpageExport.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

const pass = (req, res, next) => next();
const quiet = { info() {}, warn() {}, error() {}, debug() {} };

// Every browser start lands in `rendered`. A refused request leaves it empty.
const rendered = [];
let renderFailure = null;

const fakeContext = {
    newPage: async () => ({
        setContent: async () => {},
        waitForTimeout: async () => {},
        pdf: async () => Buffer.from('%PDF-1.7 fake'),
    }),
};

const MOCKS = {
    '../telemetry/log': quiet,
    '../stores/webpageStore': {
        getWebpage: async (id) => (id === 'wp1' ? { id, name: 'Price list' } : null),
        readAllSlots: async () => ({ html: '<p>hi</p>', css: '', js: '' }),
    },
    '../auth/permissions': { requireAuth: pass },
    '../compliance/dataPortability/stampExport': () => pass,
    '../integrations/webpageFramework': { resolveFramework: () => 'vanilla' },
    '../services/browserProvider': {
        withContext: async (opts, fn) => {
            rendered.push(opts);
            if (renderFailure) throw renderFailure;
            return fn(fakeContext);
        },
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:webpage-export-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]webpageExport\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./webpageExport');
test.after(() => { Module._resolveFilename = originalResolve; });

// A refusal or a failure travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does — with a quiet log.
const { createTerminalErrorHandler } = require('../core/http/terminalErrorHandler');
const terminalErrorHandler = createTerminalErrorHandler({ log: quiet });

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method, url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1' }, isAuthenticated: true }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, headers: {},
            setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
            getHeader(k) { return this.headers[k.toLowerCase()]; },
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

test.beforeEach(() => { rendered.length = 0; renderFailure = null; });

test('an export with no body renders the PDF', async () => {
    const res = await dispatch({ method: 'POST', url: '/wp1/export/pdf' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.headers['content-type'], 'application/pdf');
    assert.match(res.headers['content-disposition'], /Price list\.pdf/);
    assert.strictEqual(rendered.length, 1);
});

test('a paper size in the body is refused by name, instead of a Letter PDF under a 200', async () => {
    const res = await dispatch({ method: 'POST', url: '/wp1/export/pdf', body: { format: 'A4' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /'format'/, 'the sentence names the key it would have ignored');
    assert.ok(res.body.details.some((d) => d.path === 'body'));
    assert.deepStrictEqual(rendered, [], 'the browser was never started');
});

test('a failed render does not put the backend\'s own words in the answer', async () => {
    renderFailure = new Error('Browser backend unavailable (connect ENOENT /var/run/docker.sock). '
        + 'Start Docker so the server can launch the shared browser container, or set BROWSER_WS_ENDPOINT.');
    const res = await dispatch({ method: 'POST', url: '/wp1/export/pdf' });
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(res.body.error, 'Internal server error');
    assert.ok(res.body.correlationId, 'the operator can find the full error by this id');
    assert.doesNotMatch(JSON.stringify(res.body), /docker|ENOENT|BROWSER_WS_ENDPOINT/);
});

test('an unknown webpage is still a 404, before any render', async () => {
    const res = await dispatch({ method: 'POST', url: '/nope/export/pdf' });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(rendered, []);
});
