/**
 * routes/documents.js authorization (U4b — closes the GEPIND_ONGEGATE finding).
 *
 * Before this gate the three /api/documents routes never touched req.session:
 * the shared document-renderer temp directory was anonymously listable via
 * /list — download URLs included, which voided the random filename as the only
 * protection — and every file in it was anonymously fetchable via /download
 * and /view. The fix is the routes/versions.js idiom: requireAuth on the
 * router, anonymous → 401. The only live client (the mobile Documents →
 * "Generated" tab) sends the session cookie, so the gate breaks nothing.
 *
 * What is proven here: anonymous is 401'd on all three routes BEFORE any
 * filesystem access happens, and a signed-in caller still gets the listing
 * shape the mobile tab renders (plus a served file / a clean 404). What is
 * deliberately NOT proven: per-user scoping — the directory carries no
 * ownership metadata, so the listing stays shared across signed-in users; see
 * the KNOWN LIMIT note in routes/documents.js.
 *
 * Run: cd server && node --test --test-force-exit routes/documents.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A private tmp root, so the test never depends on (or leaks into) whatever a
// real document-renderer left behind on this machine.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'documents-authz-'));
const OUTPUT_DIR = path.join(TMP_ROOT, 'document-renderer');
fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUTPUT_DIR, 'abc123_report.pdf'), '%PDF-1.4 fake');

// ── fs spy: proves anonymous is rejected before any disk access ─────
const fx = { fsCalls: 0 };

const MOCKS = {
    '../auth': {
        // Mirrors the decision line of the real requireAuth
        // (auth/permissions.js:383); the cached deleted-user DB re-check is
        // that gate's own concern, not this router's.
        requireAuth: (req, res, next) => {
            if (!req.session || !req.session.isAuthenticated || !req.session.user) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
    // Builtin interposed so OUTPUT_DIR lands in the private root above.
    os: { tmpdir: () => TMP_ROOT },
    fs: new Proxy(fs, {
        get(target, prop) {
            const v = target[prop];
            if (typeof v === 'function') {
                return (...args) => { fx.fsCalls++; return v.apply(target, args); };
            }
            return v;
        },
    }),
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:documents-authz:${request}`;
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

function dispatch({ method, url, session }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, body: {}, headers: {}, query: {}, session, get() { return undefined; } };
        const res = {
            statusCode: 200,
            headers: {},
            status(c) { this.statusCode = c; return this; },
            setHeader(k, v) { this.headers[k] = v; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            sendFile(p) { this.sentFile = p; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(req, res, (err) => reject(err || new Error(`fell through router: ${method} ${url}`)));
    });
}

const anon = undefined; // no session at all — a bare curl
const authed = { isAuthenticated: true, user: { id: 'u-1' } };

// ── Anonymous: 401 on all three, before any disk access ─────────────
test('anonymous GET /list is 401 and never touches the filesystem', async () => {
    fx.fsCalls = 0;
    const res = await dispatch({ method: 'GET', url: '/list', session: anon });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(fx.fsCalls, 0, 'the 401 must fall before readdir — that is the whole point of the gate');
});

test('anonymous GET /download/:filename is 401', async () => {
    const res = await dispatch({ method: 'GET', url: '/download/abc123_report.pdf', session: anon });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.sentFile, undefined, 'no file may leave the server on a 401');
});

test('anonymous GET /view/:filename is 401', async () => {
    const res = await dispatch({ method: 'GET', url: '/view/abc123_report.pdf', session: anon });
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.sentFile, undefined);
});

test('a session without isAuthenticated is still 401 (half-built session ≠ signed in)', async () => {
    const res = await dispatch({ method: 'GET', url: '/list', session: { user: { id: 'u-1' } } });
    assert.strictEqual(res.statusCode, 401);
});

// ── Signed in: the mobile "Generated" tab contract survives the gate ─
test('signed-in GET /list returns the listing shape the mobile tab renders', async () => {
    const res = await dispatch({ method: 'GET', url: '/list', session: authed });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(Array.isArray(res.body.documents), 'the tab maps over body.documents');
    const doc = res.body.documents.find((d) => d.id === 'abc123_report.pdf');
    assert.ok(doc, 'the seeded file is listed');
    assert.strictEqual(doc.name, 'report.pdf', 'random prefix stripped from the display name');
    assert.strictEqual(doc.viewUrl, '/api/documents/view/abc123_report.pdf');
});

test('signed-in GET /view/:filename serves the file', async () => {
    const res = await dispatch({ method: 'GET', url: '/view/abc123_report.pdf', session: authed });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.sentFile, path.join(OUTPUT_DIR, 'abc123_report.pdf'));
    assert.match(res.headers['Content-Disposition'], /^inline/);
});

test('signed-in GET /download of a missing file is a clean 404, not a 401', async () => {
    const res = await dispatch({ method: 'GET', url: '/download/nope_gone.pdf', session: authed });
    assert.strictEqual(res.statusCode, 404);
});
