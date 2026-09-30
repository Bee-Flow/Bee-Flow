/**
 * GET /api/webpages/:id/draft-document (routes/webpages/draftDocument.js).
 *
 * What is pinned, refusals first:
 *
 *   ACCESS    a stranger and an unknown id both get 404, and no token is
 *             minted for them; a query string is a 400.
 *   READER    a published reader gets the PINNED slots, never the owner's
 *             live row, and a token scoped to the owner with the reader as
 *             viewer — what POST /:id/preview-token gives them on the web.
 *   FRAMEWORK a plain page and a React page both come back as a document with
 *             the live bridges baked in; a React page with no entry, one that
 *             fails to build, and React source in a plain page each say so.
 *   SECRETS   the response carries the whitelisted keys only, and nothing
 *             from the signing secret or the session.
 *
 * No DB: auth is stubbed before the router loads and every store touch is
 * monkey-patched (same pattern as webpages.validation.test.js). The React
 * cases run the real esbuild.
 *
 * Run: cd server && node --test routes/webpages/draftDocument.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';
const SECRET = 'draft-document-test-secret-0123456789abcdef';
process.env.WEBPAGE_PREVIEW_TOKEN_SECRET = SECRET;

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const perms = require('../../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();
const audience = require('../../auth/audience');
audience.resolveAudienceContext = async (req) => ({
    userId: req.session.user.id, orgIds: ['org1'], userGroups: [],
});

const webpageStore = require('../../stores/webpageStore');
const { verifyPreviewToken } = require('../../auth/webpagePreviewToken');
const { _internals: draftInternals } = require('../../services/webpageDraftDocument');
const webpagesRouter = require('../webpages');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

const LIVE = { html: '<html><head></head><body><h1>LIVE DRAFT</h1></body></html>', css: 'h1{color:red}', js: 'window.x=1;' };
const PINNED = { html: '<html><head></head><body><h1>PINNED</h1></body></html>', css: '', js: '' };

const REACT_FILES = {
    'src/main.jsx': "import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\ncreateRoot(document.getElementById('root')).render(<App />);\n",
    'src/App.jsx': 'export default function App() { return <h1>Hello from React</h1>; }\n',
};

let page;
let extraFiles;
let readerAllowed;
let slotReads;

function basePage(settings = {}) {
    return {
        id: 'wp1', userId: 'alice', name: 'Page', isPublished: true, sharedGroups: [],
        organizationId: 'org1', publishedVersionId: 'v1', projectId: null,
        settings, updatedAt: '2026-09-27T10:00:00.000Z',
    };
}

function textFiles(map) {
    return Object.entries(map).map(([path, content]) => ({ path, isText: true, mimeType: 'text/javascript', content }));
}

function stubs() {
    return [
        [webpageStore, 'getWebpage', async (id, userId) => (id === page.id && userId === page.userId ? { ...page } : null)],
        [webpageStore, 'getWebpageRaw', async (id) => (id === page.id ? { ...page } : null)],
        [webpageStore, 'canReadWebpageAsync', async () => readerAllowed],
        [webpageStore, 'getVersionMeta', async (id) => ({ id, webpageId: 'wp1' })],
        [webpageStore, 'readAllSlots', async (_owner, _id, versionId) => {
            slotReads.push(versionId ?? null);
            return versionId ? { ...PINNED } : { ...LIVE };
        }],
        [webpageStore, 'listExtraFiles', async () => extraFiles.map(({ path, isText, mimeType }) => ({ path, isText, mimeType }))],
        [webpageStore, 'readExtraFile', async ({ path }) => {
            const f = extraFiles.find((x) => x.path === path);
            if (!f) return null;
            return f.isText ? { text: f.content } : { bytes: Buffer.from(f.content) };
        }],
    ];
}

let base = null;
test.before(async (t) => {
    const originals = stubs().map(([obj, key, value]) => {
        const orig = obj[key];
        obj[key] = value;
        return [obj, key, orig];
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { user: { id: req.get('x-user') || 'alice', organizationId: 'org1' }, cookieSecret: 'session-secret-value' };
        next();
    });
    app.use(webpagesRouter);
    app.use(terminalErrorHandler);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    t.after(() => {
        server.close();
        for (const [obj, key, orig] of originals) obj[key] = orig;
    });
});

test.beforeEach(() => {
    page = basePage();
    extraFiles = [];
    readerAllowed = false;
    slotReads = [];
    draftInternals.bundleCache.clear();
});

async function getDoc(path = '/wp1/draft-document', user = 'alice') {
    const res = await fetch(`${base}${path}`, { headers: { 'x-user': user } });
    let body = null;
    try { body = await res.json(); } catch { /* not JSON */ }
    return { status: res.status, body, headers: res.headers };
}

/** The token baked into the document's auth script. */
function bakedToken(html) {
    const m = /var TOKEN = "([^"]+)";/.exec(html);
    return m ? m[1] : null;
}

test('a stranger gets 404 and no document', async () => {
    const r = await getDoc('/wp1/draft-document', 'mallory');
    assert.strictEqual(r.status, 404);
    assert.strictEqual(r.body.html, undefined);
    assert.deepStrictEqual(slotReads, []);
});

test('an unknown page is 404', async () => {
    const r = await getDoc('/nope/draft-document');
    assert.strictEqual(r.status, 404);
});

test('a query string is refused, not ignored', async () => {
    const r = await getDoc('/wp1/draft-document?token=x');
    assert.strictEqual(r.status, 400);
});

test('the owner gets the live draft of a plain page, bridges and token baked in', async () => {
    const r = await getDoc();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.status, 'ready');
    assert.strictEqual(r.body.framework, 'vanilla');
    assert.strictEqual(r.body.runtime, 'light');
    assert.strictEqual(r.body.updatedAt, '2026-09-27T10:00:00.000Z');
    assert.match(r.headers.get('cache-control'), /no-store/);
    const { html } = r.body;
    assert.ok(html.includes('LIVE DRAFT'));
    assert.ok(html.includes('<style>\nh1{color:red}\n</style>'));
    assert.ok(html.includes('window.x=1;'));
    assert.ok(html.includes(`var BASE = ${JSON.stringify(base)} + "/api/webpages-preview/wp1/db"`));
    assert.ok(html.includes('window.beeflowAI = {'));
    assert.ok(!html.includes('is not available here'), 'live bridges, not the stubs');
    const claims = verifyPreviewToken(bakedToken(html));
    assert.deepStrictEqual(
        { userId: claims.userId, webpageId: claims.webpageId, viewerUserId: claims.viewerUserId },
        { userId: 'alice', webpageId: 'wp1', viewerUserId: 'alice' },
    );
    assert.strictEqual(r.body.expiresAt, claims.expiresAt);
    assert.deepStrictEqual(slotReads, [null]);
});

test('a published reader gets the pinned slots and a token scoped to the owner', async () => {
    readerAllowed = true;
    const r = await getDoc('/wp1/draft-document', 'bob');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.html.includes('PINNED'));
    assert.ok(!r.body.html.includes('LIVE DRAFT'));
    assert.deepStrictEqual(slotReads, ['v1']);
    const claims = verifyPreviewToken(bakedToken(r.body.html));
    assert.strictEqual(claims.userId, 'alice');
    assert.strictEqual(claims.viewerUserId, 'bob');
});

test('project files a plain page references are inlined', async () => {
    page.settings = {};
    extraFiles = [
        { path: 'theme.css', isText: true, mimeType: 'text/css', content: ':root{--a:1}' },
        { path: 'logo.png', isText: false, mimeType: 'image/png', content: 'PNG' },
    ];
    const live = LIVE.html;
    LIVE.html = '<html><head><link rel="stylesheet" href="theme.css"></head><body><img src="logo.png"></body></html>';
    try {
        const { body } = await getDoc();
        assert.ok(body.html.includes('<style>\n:root{--a:1}\n</style>'));
        assert.ok(body.html.includes(`src="data:image/png;base64,${Buffer.from('PNG').toString('base64')}"`));
    } finally {
        LIVE.html = live;
    }
});

test('React source in a plain page is reported as stranded', async () => {
    extraFiles = textFiles({ 'src/main.jsx': REACT_FILES['src/main.jsx'] });
    const { body } = await getDoc();
    assert.strictEqual(body.status, 'stranded');
    assert.strictEqual(body.html, null);
    assert.strictEqual(body.expiresAt, null);
});

test('a React page is bundled on the server with the live bridges, and cached', async () => {
    page.settings = { framework: 'react-mui' };
    extraFiles = textFiles(REACT_FILES);
    const first = await getDoc();
    assert.strictEqual(first.body.status, 'ready');
    assert.strictEqual(first.body.framework, 'react-mui');
    const { html } = first.body;
    assert.ok(html.includes('<script type="importmap">'));
    assert.ok(html.includes('Hello from React'));
    assert.ok(html.includes('/api/webpages-preview/wp1/db'));
    assert.ok(!html.includes('is not available here'), 'live bridges, not the stubs');
    assert.ok(verifyPreviewToken(bakedToken(html)));
    assert.strictEqual(draftInternals.bundleCache.size, 1);

    const second = await getDoc();
    assert.strictEqual(draftInternals.bundleCache.size, 1, 'same draft, same bundle');
    assert.notStrictEqual(bakedToken(second.body.html), null);

    extraFiles = textFiles({ ...REACT_FILES, 'src/App.jsx': 'export default function App() { return <p>Changed</p>; }\n' });
    const third = await getDoc();
    assert.ok(third.body.html.includes('Changed'));
    assert.strictEqual(draftInternals.bundleCache.size, 2, 'a changed draft is a new entry');
});

test('a React page with no entry yet is empty', async () => {
    page.settings = { framework: 'react-mui' };
    extraFiles = textFiles({ 'src/App.jsx': REACT_FILES['src/App.jsx'] });
    const { body } = await getDoc();
    assert.strictEqual(body.status, 'empty');
    assert.strictEqual(body.html, null);
});

test('a React page that fails to build says why', async () => {
    page.settings = { framework: 'react-mui' };
    extraFiles = textFiles({ 'src/main.jsx': "import Missing from './Missing.jsx';\nMissing();\n" });
    const { body } = await getDoc();
    assert.strictEqual(body.status, 'build_error');
    assert.strictEqual(body.html, null);
    assert.match(body.buildError, /Missing/);
});

test('the response carries its whitelisted keys and no secret', async () => {
    const r = await getDoc();
    assert.deepStrictEqual(
        Object.keys(r.body).sort(),
        ['buildError', 'expiresAt', 'framework', 'html', 'runtime', 'status', 'updatedAt'],
    );
    const raw = JSON.stringify(r.body);
    assert.ok(!raw.includes(SECRET));
    assert.ok(!raw.includes('session-secret-value'));
    assert.ok(!raw.includes('organizationId'));
});
