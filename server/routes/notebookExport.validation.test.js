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
// When set, the browser backend throws this instead of rendering.
let renderFailure = null;
// When set, SignRequest throws this instead of sending.
let signFailure = null;
const pass = (req, res, next) => next();

const MOCKS = {
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {} },
    '../templates/exportTemplate': {
        buildExportHTML: (html, opts) => `<html data-title="${opts.title}">${html}</html>`,
        cleanContentForExport: (html) => html,
    },
    // The house-style helpers live in core/documents/docxHouseStyle.js and
    // read the store from there (see the resolver below).
    '../../stores/houseStyleStore': {
        getById: async (id, orgId) => {
            if (orgId !== 'org-1') return null;
            if (id === 'hs-1') return { id: 'hs-1', name: 'Huisstijl', styleMeta: {} };
            if (id === 'hs-hf') return { id: 'hs-hf', name: 'Briefpapier', styleMeta: { header: { text: 'Acme BV' }, footer: { text: 'Vertrouwelijk' } } };
            return null;
        },
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
        isBackendUnavailable: (err) => !!err && err.code === 'browser_backend_unavailable',
        withContext: async () => {
            touched.push({ what: 'render' });
            if (renderFailure) throw renderFailure;
            return Buffer.from('%PDF-1.7');
        },
    },
    '../auth/permissions': { requireAuth: pass },
    '../integrations/signrequestTools': {
        sendPdfForSigning: async (userId, p) => {
            touched.push({ what: 'sign', args: [p] });
            if (signFailure) throw signFailure;
            return { uuid: 's1', signers: [] };
        },
    },
    '../stores/configStore': { getConfig: async () => ({ nextcloudUrl: 'https://cloud.example' }) },
    '@turbodocx/html-to-docx': async (...args) => { touched.push({ what: 'docx', args }); return Buffer.from('PK'); },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:notebook-export-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /(routes[\\/]notebookExport|core[\\/]documents[\\/]docxHouseStyle)\.js$/.test(parent.filename)
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

test.beforeEach(() => { touched.length = 0; renderFailure = null; signFailure = null; });

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

test('the house style\'s header and footer reach html-to-docx as its positional arguments', async () => {
    const before = calls('docx').length;
    const res = await dispatch({ url: '/nb-1/export/docx', body: { content: '<p>x</p>', houseStyleId: 'hs-hf' } });
    assert.strictEqual(res.statusCode, 200);
    const [, header, options, footer] = calls('docx')[before].args;
    assert.match(header, /Acme BV/);
    assert.match(footer, /Vertrouwelijk/);
    assert.strictEqual(options.headerHTML, undefined, 'not as an option key, which the library ignores');
    assert.strictEqual(options.footerHTML, undefined);
});

// ── Nextcloud folder ────────────────────────────────────────────────

test('a folder that steps up with .. is refused before anything is rendered or uploaded', async () => {
    const res = await dispatch({ url: '/nb-1/export/nextcloud', body: { content: '<p>x</p>', folder: '/BeeFlow/../../other' } });
    assert.ok(refusedAt(res, 'body.folder'));
    assert.deepStrictEqual(touched, []);
});

// ── A render that fails ─────────────────────────────────────────────

function backendDown() {
    const err = new Error('Browser backend unavailable (docker_unavailable: connect ENOENT /var/run/docker.sock). '
        + 'Run the browser sidecar and set BROWSER_WS_ENDPOINT, or set BROWSER_ALLOW_LOCAL_LAUNCH=true.');
    err.code = 'browser_backend_unavailable';
    return err;
}

for (const route of ['pdf', 'signrequest', 'nextcloud']) {
    test(`no browser backend on /export/${route} is a 503 the user can act on, without the operator's words`, async () => {
        renderFailure = backendDown();
        const body = { content: '<p>x</p>', title: 'Plan' };
        if (route === 'signrequest') body.signers = [{ email: 'anna@example.nl' }];
        const res = await dispatch({ url: `/nb-1/export/${route}`, body });
        assert.strictEqual(res.statusCode, 503);
        assert.strictEqual(res.body.code, 'pdf_renderer_unavailable');
        assert.strictEqual(res.body.error,
            require('../i18n/defaults/en/notebooks')['notebooks.pdf_renderer_unavailable'],
            'the sentence comes from the English dictionary the client translates');
        assert.doesNotMatch(JSON.stringify(res.body), /docker|ENOENT|BROWSER_|sock/i);
        assert.deepStrictEqual(calls('sign'), [], 'nothing was sent after a failed render');
    });
}

test('any other render failure is the generic 500 with a correlation id, not the error text', async () => {
    renderFailure = new Error('page.pdf: Target closed at /runner/node_modules/playwright-core/lib/x.js:12');
    const res = await dispatch({ url: '/nb-1/export/pdf', body: { content: '<p>x</p>' } });
    assert.strictEqual(res.statusCode, 500);
    assert.ok(res.body.correlationId);
    assert.doesNotMatch(JSON.stringify(res.body), /Target closed|playwright|runner/);
});

test('SignRequest that is not set up is a 400 that says where to set it up', async () => {
    signFailure = Object.assign(new Error('SignRequest not configured. Add your SignRequest subdomain and API token in Settings → Integrations.'),
        { code: 'signrequest_not_configured' });
    const res = await dispatch({ url: '/nb-1/export/signrequest', body: { content: '<p>x</p>', signers: [{ email: 'anna@example.nl' }] } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'signrequest_not_configured');
    assert.match(res.body.error, /Settings → Integrations/);
});
