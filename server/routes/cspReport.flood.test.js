/**
 * The CSP report sink stays open, and stays bounded (routes/cspReport.js).
 *
 * The body is the browser's, so it has no schema — see the file header. What
 * it did not have either was a bound on its COUNT: every element of an array
 * body became a log line, and nothing limited the requests. A body of `{}`s is
 * three bytes an element, and a JSON content type is parsed by the app-wide
 * 20 MB parser before the route's own 32 KB one, so one anonymous request
 * could write millions of lines into the operator's log.
 *
 * Pinned here, through a real HTTP request:
 *
 *   - a flood in ONE request logs at most MAX_REPORTS_PER_REQUEST lines, plus
 *     one saying how many were not logged;
 *   - both browser shapes still log a line each;
 *   - the per-IP limiter answers 429 after sixty reports in a minute.
 *
 * Run: cd server && node --test routes/cspReport.flood.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

const lines = [];
const MOCKS = {
    '../telemetry/log': {
        warn: (...a) => { lines.push(a.join(' ')); },
        info: () => {}, error: () => {}, debug: () => {},
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:csp-report-flood:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]cspReport\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./cspReport');

let server;
let baseUrl;

test.before(async () => {
    const app = express();
    // The app-wide parser index.js mounts first — it is what reads a JSON body.
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/csp-report', router);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    await new Promise((resolve) => server.close(resolve));
});

function post(body, type = 'application/json') {
    return fetch(`${baseUrl}/api/csp-report`, {
        method: 'POST', headers: { 'content-type': type }, body: JSON.stringify(body),
    });
}

test('ten thousand reports in one request log twenty lines and a count, not ten thousand', async () => {
    lines.length = 0;
    const res = await post(Array.from({ length: 10_000 }, () => ({})));
    assert.strictEqual(res.status, 204);
    const reports = lines.filter((l) => l.startsWith('[csp-report] {'));
    assert.strictEqual(reports.length, 20);
    assert.ok(lines.some((l) => l.includes('9980 more report(s) in this request were not logged')), lines.at(-1));
});

test('both browser shapes still log their violation', async () => {
    lines.length = 0;
    let res = await post({ 'csp-report': { 'blocked-uri': 'https://cdn.example/x.js', 'violated-directive': 'script-src' } }, 'application/csp-report');
    assert.strictEqual(res.status, 204);
    res = await post([{ type: 'csp-violation', body: { blockedURL: 'https://cdn.example/y.js', effectiveDirective: 'img-src' } }], 'application/reports+json');
    assert.strictEqual(res.status, 204);
    assert.strictEqual(lines.length, 2);
    assert.match(lines[0], /x\.js.*script-src/);
    assert.match(lines[1], /y\.js.*img-src/);
});

test('a null in the array is skipped, not a parse failure that loses its neighbours', async () => {
    lines.length = 0;
    const res = await post([null, { blockedURL: 'https://cdn.example/z.js' }]);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(lines.filter((l) => l.includes('z.js')).length, 1);
});

test('the per-IP limiter answers 429 once a minute\'s worth of reports is spent', async () => {
    let last = 204;
    for (let i = 0; i < 70 && last !== 429; i += 1) {
        last = (await post({ 'csp-report': {} })).status;
    }
    assert.strictEqual(last, 429);
});
