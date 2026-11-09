/**
 * POST /:id/export/nextcloud uploads through the person's own Nextcloud
 * connection (routes/notebookExport.js).
 *
 * The route built its own WebDAV calls: the organisation's URL, the saved app
 * password, and the saved login name as the uid. So it refused everyone
 * connected through OAuth or the connector app ("not connected"), sent a
 * person's app password to the organisation's host when they had saved their
 * own Nextcloud URL, and wrote to /files/<login name>/, which is not the uid
 * for an e-mail or LDAP login. It now uses the connection every other
 * Nextcloud feature resolves (nextcloudClient.resolveAuth).
 *
 * Run: cd server && node --test routes/notebookExport.nextcloud.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// The WebDAV helpers load the real nextcloudClient, which pulls the database in at load.
require('../testUtils/routeHarness').recordDb();

const pass = (req, res, next) => next();
const BASE = 'https://my-own-cloud.example';

/** @type {{ method: string, url: string, body?: unknown }[]} */
let davCalls = [];
/** Paths that already exist on the fake Nextcloud. */
let existing = new Set();
let connected = true;

const PROPFIND_HIT = (href) => `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"><d:response><d:href>${href}</d:href>
<d:propstat><d:prop><d:resourcetype/><d:getcontentlength>3</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const reply = (status, text = '') => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => text });

async function fakeNcFetch(url, opts = {}) {
    const method = opts.method || 'GET';
    davCalls.push({ method, url, body: opts.body });
    const path = decodeURIComponent(new URL(url).pathname);
    if (method === 'PROPFIND') return existing.has(path) ? reply(207, PROPFIND_HIT(new URL(url).pathname)) : reply(404);
    if (method === 'MKCOL') return reply(201);
    if (method === 'PUT') return reply(201);
    return reply(500);
}

const MOCKS = {
    '../telemetry/log': { info() {}, warn() {}, error() {}, debug() {}, nameForLog: (s) => s },
    '../templates/exportTemplate': { buildExportHTML: (html) => `<html>${html}</html>`, cleanContentForExport: (html) => html },
    '../stores/notebookStore': { getNotebook: async (id, userId) => (id === 'nb-1' && userId === 'u1' ? { id: 'nb-1' } : null) },
    '../stores/userStore': {
        getUser: async () => ({ id: 'u1', organizationId: 'org-1' }),
        // No app password at all: this person signed in with Nextcloud.
        getAppPassword: async () => null,
    },
    '../stores/lib/documentCrypto': { withDocumentEncryptionSession: pass },
    '../services/browserProvider': {
        isBackendUnavailable: () => false,
        withContext: async (_opts, fn) => fn({
            route: async () => {}, routeWebSocket: async () => {},
            newPage: async () => ({ setContent: async () => {}, evaluate: async () => {}, pdf: async () => Buffer.from('%PDF-1.7') }),
        }),
    },
    '../auth/permissions': { requireAuth: pass },
    '../integrations/signrequestTools': { sendPdfForSigning: async () => ({}) },
    // The organisation has no Nextcloud URL configured; the person's own connection decides.
    '../stores/configStore': { getConfig: async () => ({}) },
    '../integrations/nextcloudClient': {
        resolveAuth: async () => {
            if (!connected) throw new Error('Nextcloud not connected. Log in via Nextcloud OAuth, or add your username and app password in Settings → Connections.');
            return { mode: 'bearer', baseUrl: BASE, uid: 'jan', fetch: fakeNcFetch, authError: 'Nextcloud session expired — please log in again.' };
        },
        webdavRoot: (baseUrl, uid) => `${baseUrl}/remote.php/dav/files/${encodeURIComponent(uid)}`,
    },
    '@turbodocx/html-to-docx': async () => Buffer.from('PK'),
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:notebook-export-nextcloud:${request}`;
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

function dispatch(body) {
    const url = '/nb-1/export/nextcloud';
    return new Promise((resolve, reject) => {
        const req = {
            method: 'POST', url, originalUrl: url, path: url, body, query: {}, headers: {},
            session: { user: { id: 'u1', name: 'Jan' } }, get() { return undefined; },
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

test.beforeEach(() => { davCalls = []; existing = new Set(); connected = true; });

const ROOT = `${BASE}/remote.php/dav/files/jan`;

test('the PDF goes to the person\'s own connection: their host, their uid, no app password needed', async () => {
    const res = await dispatch({ content: '<p>x</p>', title: 'Plan Q3', folder: '/Mijn map/Notities' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(davCalls.map((c) => `${c.method} ${c.url}`), [
        `PROPFIND ${ROOT}/Mijn%20map/Notities/Plan%20Q3.pdf`,
        `MKCOL ${ROOT}/Mijn%20map`,
        `MKCOL ${ROOT}/Mijn%20map/Notities`,
        `PUT ${ROOT}/Mijn%20map/Notities/Plan%20Q3.pdf`,
    ]);
    assert.ok(Buffer.isBuffer(davCalls[3].body));
    assert.deepStrictEqual(
        { path: res.body.path, fileName: res.body.fileName, folderUrl: res.body.folderUrl },
        { path: '/Mijn map/Notities/Plan Q3.pdf', fileName: 'Plan Q3.pdf', folderUrl: `${BASE}/index.php/apps/files/?dir=${encodeURIComponent('/Mijn map/Notities')}` },
    );
});

test('an existing file is kept: the new one gets a timestamp in its name', async () => {
    existing.add('/remote.php/dav/files/jan/BeeFlow/Notebooks/Plan.pdf');
    const res = await dispatch({ content: '<p>x</p>', title: 'Plan' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    assert.match(res.body.fileName, /^Plan \(\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\)\.pdf$/);
    const put = davCalls.find((c) => c.method === 'PUT');
    assert.strictEqual(put.url, `${ROOT}/BeeFlow/Notebooks/${encodeURIComponent(res.body.fileName)}`);
});

test('no Nextcloud connection is a 400 that says what to do, before anything is rendered', async () => {
    connected = false;
    const res = await dispatch({ content: '<p>x</p>', title: 'Plan' });
    assert.strictEqual(res.statusCode, 400);
    assert.match(res.body.error, /Nextcloud not connected/);
    assert.deepStrictEqual(davCalls, []);
});
