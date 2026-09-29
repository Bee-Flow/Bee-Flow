/**
 * Which file names the rendered-document routes serve (routes/documents.js).
 *
 * The file name on the path used to be CLEANED — every character outside
 * [A-Za-z0-9._-] dropped — and then looked up. That answered a request for
 * one name with a different file whenever the cleaned name existed, served
 * any file in the directory as application/pdf, and made a listed file whose
 * name held a space unreachable ("It may have expired"). What this file pins:
 *
 *   - a name outside the pattern is refused with a sentence and nothing is
 *     sent, rather than being rewritten into another name;
 *   - only .pdf names are served, the same names /list offers;
 *   - /list offers only names the two file routes serve, so no link is dead.
 *
 * Run: cd server && node --test --test-force-exit routes/documents.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A private temp root, so the real document-renderer directory is never read.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-validation-'));
const OUTPUT_DIR = path.join(TMP_ROOT, 'document-renderer');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, 'abc123_report.pdf'), '%PDF-1.4 fake');
// Two names that the old cleaning collapsed into one another.
fs.writeFileSync(path.join(OUTPUT_DIR, 'def456_Q3report.pdf'), '%PDF-1.4 the OTHER file');
fs.writeFileSync(path.join(OUTPUT_DIR, 'def456_Q3 report.pdf'), '%PDF-1.4 fake');
// Not a PDF, but in the same directory.
fs.writeFileSync(path.join(OUTPUT_DIR, 'ghi789_notes.txt'), 'plain text');

const MOCKS = {
    '../auth': { requireAuth: (req, res, next) => next() },
    // Builtin interposed so OUTPUT_DIR lands in the private root above.
    os: { tmpdir: () => TMP_ROOT },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:documents-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]documents\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./documents');
test.after(() => {
    Module._resolveFilename = originalResolve;
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'GET', url, originalUrl: url, path: url, body: undefined, query: {}, headers: {},
            session: { isAuthenticated: true, user: { id: 'u-1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this.headers[k] = v; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            sendFile(p) { this.sentFile = p; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: GET ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test('a listed name is served as it is', async () => {
    const res = await dispatch({ url: '/download/abc123_report.pdf' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.sentFile, path.join(OUTPUT_DIR, 'abc123_report.pdf'));
});

test('a name with a space is refused, instead of being cleaned into ANOTHER file', async () => {
    const res = await dispatch({ url: `/download/${encodeURIComponent('def456_Q3 report.pdf')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /ending in \.pdf/);
    assert.ok(res.body.details.some((d) => d.path === 'params.filename'));
    assert.strictEqual(res.sentFile, undefined, 'def456_Q3report.pdf was not handed out in its place');
});

test('a path that climbs out of the directory is refused before the disk is looked at', async () => {
    const res = await dispatch({ url: `/view/${encodeURIComponent('../../etc/passwd')}` });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.sentFile, undefined);
});

test('a file that is not a PDF is not served as one', async () => {
    const res = await dispatch({ url: '/view/ghi789_notes.txt' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.sentFile, undefined);
});

test('/list offers only names the file routes serve', async () => {
    const res = await dispatch({ url: '/list' });
    assert.strictEqual(res.statusCode, 200);
    const ids = res.body.documents.map((d) => d.id).sort();
    assert.deepStrictEqual(ids, ['abc123_report.pdf', 'def456_Q3report.pdf'],
        'the name with a space is not offered as a link that cannot be opened');
});
