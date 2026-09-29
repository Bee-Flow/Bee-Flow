/**
 * What the notebook export routes accept, and what they say when they refuse
 * (routes/notebookExport.js).
 *
 * A title that was not text reached `title.replace` only AFTER the Chromium
 * render, so the PDF was built and thrown away with a 500; a signer's
 * misspelled `frist_name` was dropped and the signer mailed without a name;
 * a house style that does not exist exported the document with no style at
 * all. What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.signers.0`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - nothing is rendered or sent, so a refused request costs nothing.
 *
 * Run: cd server && node --test routes/notebookExport.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every render, build or send lands in `touched`. A refused request must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const MOCKS = {
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../templates/exportTemplate': {
        buildExportHTML: (html, opts) => `<html data-title="${opts.title}">${html}</html>`,
        cleanContentForExport: (html) => html,
    },
    '../stores/houseStyleStore': {
        getById: async (id, orgId) => (id === 'hs-1' && orgId === 'org-1' ? { id: 'hs-1', name: 'Huisstijl', styleMeta: {} } : null),
        getDefaultForOrg: async () => { touched.push({ what: 'defaultStyle' }); return null; },
    },
    '../stores/notebookStore': {
        getNotebook: async (id, userId) => (id === 'nb-1' && userId === 'u1' ? { id: 'nb-1' } : null),
    },
    '../stores/userStore': {
        getUser: async () => ({ id: 'u1', organizationId: 'org-1' }),
        getAppPassword: async () => ({ username: 'alice', password: 'app-pass' }),
    },
    '../services/browserProvider': {
        withContext: async () => { touched.push({ what: 'render' }); return Buffer.from('%PDF-1.7'); },
    },
    '../auth/permissions': { requireAuth: pass },
    '../integrations/signrequestTools': {
        sendPdfForSigning: async (userId, p) => { touched.push({ what: 'sign', args: [p] }); return { uuid: 's1', signers: [] }; },
    },
    '../stores/configStore': { getConfig: async () => ({ nextcloudUrl: 'https://cloud.example' }) },
    'html-to-docx': async () => { touched.push({ what: 'docx' }); return Buffer.from('PK'); },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:notebook-export-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]notebookExport\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./notebookExport');
test.after(() => { Module._resolveFilename = originalResolve; });

const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

function dispatch({ url, body }) {
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1', name: 'Alice' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false, headers: {},
            setHeader(k, v) { this.headers[String(k).toLowerCase()] = v; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: POST ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const refusedAt = (res, path) => res.statusCode === 400 && res.body.details.some((d) => d.path === path);
const calls = (what) => touched.filter((t) => t.what === what);

test.beforeEach(() => { touched.length = 0; });

// ── title and content ───────────────────────────────────────────────

test('a notebook without a name exports as "Notebook" instead of a 500 after the render', async () => {
    const res = await dispatch({ url: '/nb-1/export/pdf', body: { content: '<p>Hoi</p>', title: null } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('render').length, 1);
    assert.strictEqual(res.headers['content-disposition'], 'attachment; filename="Notebook.pdf"');
});

test('a title that is not text is refused before anything is rendered', async () => {
    const res = await dispatch({ url: '/nb-1/export/pdf', body: { content: '<p>Hoi</p>', title: 42 } });
    assert.ok(refusedAt(res, 'body.title'));
    assert.strictEqual(res.body.error, 'A title must be text.');
    assert.deepStrictEqual(touched, []);
});

test('an export with no content is refused in words, not with "Required"', async () => {
    const res = await dispatch({ url: '/nb-1/export/pdf', body: { title: 'Plan' } });
    assert.ok(refusedAt(res, 'body.content'));
    assert.strictEqual(res.body.error, 'An export needs the notebook content as HTML.');
});

test('an unknown key is refused by name', async () => {
    const res = await dispatch({ url: '/nb-1/export/pdf', body: { content: '<p>x</p>', format: 'A4' } });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /format/);
    assert.deepStrictEqual(touched, []);
});

test('a notebook that is not yours is a 404 whatever the body says', async () => {
    const res = await dispatch({ url: '/nb-other/export/pdf', body: { title: 42 } });
    assert.strictEqual(res.statusCode, 404);
});

// ── SignRequest ─────────────────────────────────────────────────────

test('signers given as one address string is refused before the render', async () => {
    const res = await dispatch({ url: '/nb-1/export/signrequest', body: { content: '<p>x</p>', signers: 'a@b.nl' } });
    assert.ok(refusedAt(res, 'body.signers'));
    assert.deepStrictEqual(touched, []);
});

test('a misspelled signer key is refused, not mailed to a signer without a name', async () => {
    const res = await dispatch({
        url: '/nb-1/export/signrequest',
        body: { content: '<p>x</p>', signers: [{ email: 'anna@example.nl', frist_name: 'Anna' }] },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'body.signers.0'));
    assert.deepStrictEqual(calls('sign'), []);
});

test('the web form\'s own shape is accepted, with the address trimmed', async () => {
    const res = await dispatch({
        url: '/nb-1/export/signrequest',
        body: {
            content: '<p>x</p>', title: 'Contract',
            signers: [{ email: ' anna@example.nl ', first_name: '', last_name: '' }],
            subject: '', message: '',
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(calls('sign')[0].args[0].signers[0].email, 'anna@example.nl');
});

test('no signers at all is refused in words', async () => {
    const res = await dispatch({ url: '/nb-1/export/signrequest', body: { content: '<p>x</p>', signers: [] } });
    assert.ok(refusedAt(res, 'body.signers'));
    assert.strictEqual(res.body.error, 'At least one signer is required.');
});

// ── DOCX house style ────────────────────────────────────────────────

test('a house style that does not exist is a 404, not an export with no style at all', async () => {
    const res = await dispatch({ url: '/nb-1/export/docx', body: { content: '<p>x</p>', houseStyleId: 'hs-deleted' } });
    assert.strictEqual(res.statusCode, 404);
    assert.deepStrictEqual(calls('docx'), []);
});

test('an existing house style, none, and the org default all still export', async () => {
    for (const body of [
        { content: '<p>x</p>', houseStyleId: 'hs-1' },
        { content: '<p>x</p>', houseStyleId: 'none' },
        { content: '<p>x</p>' },
    ]) {
        const res = await dispatch({ url: '/nb-1/export/docx', body });
        assert.strictEqual(res.statusCode, 200, JSON.stringify(body));
    }
    assert.strictEqual(calls('docx').length, 3);
    assert.strictEqual(calls('defaultStyle').length, 1, 'only the request without an id asks for the default');
});

// ── Nextcloud folder ────────────────────────────────────────────────

test('a folder that steps up with .. is refused before anything is rendered or uploaded', async () => {
    const res = await dispatch({ url: '/nb-1/export/nextcloud', body: { content: '<p>x</p>', folder: '/BeeFlow/../../other' } });
    assert.ok(refusedAt(res, 'body.folder'));
    assert.deepStrictEqual(touched, []);
});
