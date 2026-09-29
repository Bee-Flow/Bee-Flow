'use strict';

/**
 * What the platform-module admin routes accept, and what they say when they
 * refuse (routes/admin/modules.js).
 *
 * Four silent fall-backs lived here, each one answered with a 200:
 *
 *   - `PATCH /:id/update-policy` with `pin: 'patch'` stored NO pin at all, so
 *     a module an operator asked to hold on its major line was left following
 *     every release — and the row came back "saved";
 *   - the same route with `channel: 'Beta'` kept the module on stable;
 *   - `GET /:id/logs?level=warning` filtered the ring buffer on a level that
 *     does not exist, so the dialog showed an empty list — read as "this
 *     module has logged nothing";
 *   - `POST /connect` with a misspelled `hubURL` connected the install to the
 *     DEFAULT hub instead of the one the operator typed, and stored it.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`body.pin`), not just "invalid request";
 *   - the message is a sentence, including for a field simply left out;
 *   - the loader and the store are never reached, so a refused request
 *     changes nothing.
 *
 * Run: cd server && node --test routes/admin/modules.validation.test.js
 */

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// Every effectful call lands in `touched`. A refused request must leave it empty.
const touched = [];

mock(path.join(SERVER, 'modules'), {
    importModule: async () => ({ ok: true, module: {} }),
    removeModule: async () => ({ ok: true, module: {} }),
    invalidateCache: () => {},
});
mock(path.join(SERVER, 'modules/hubClient'), {
    getConnection: async () => ({ connected: true, hubUrl: 'https://hub.example' }),
    connect: async (params) => { touched.push({ what: 'connect', args: [params] }); return { connected: true }; },
    disconnect: async () => {},
    createPurchase: async (p) => { touched.push({ what: 'createPurchase', args: [p] }); return { status: 'active' }; },
    fetchCatalogEntry: async () => null,
});
mock(path.join(SERVER, 'modules/remoteCatalog'), {
    listMarketplace: async (params) => { touched.push({ what: 'listMarketplace', args: [params] }); return { modules: [], nextCursor: null, stale: false }; },
    isRemoteRow: () => true,
    isEntitled: () => true,
    marketplaceRow: (m) => m,
});
mock(path.join(SERVER, 'modules/packageLoader'), {
    getRuntimeHealth: () => ({ replica: 'r1', dispatchedCount: 0, reconciler: { boot: null }, limits: {}, modules: {} }),
    isInstalling: () => false,
    installFromHub: async (id, opts) => { touched.push({ what: 'installFromHub', args: [id, opts] }); },
    getInstallProgress: async () => null,
    updateModule: async (id, opts) => { touched.push({ what: 'updateModule', args: [id, opts] }); return { version: '1.1.0' }; },
    reactivateModule: async () => ({ version: '1.0.0' }),
    listVersions: async () => [],
    sideloadFromBuffer: async () => ({ version: '1.0.0' }),
    applyOfflineGrant: async () => ({ entitlement: { kind: 'perpetual', exp: null } }),
    activateStaged: async (id, opts) => { touched.push({ what: 'activateStaged', args: [id, opts] }); return { version: '1.0.0' }; },
    rollbackTo: async (id, opts) => { touched.push({ what: 'rollbackTo', args: [id, opts] }); return { version: '0.9.0' }; },
});
mock(path.join(SERVER, 'modules/entitlementRefresh'), { getHealth: () => ({}), tick: async () => {} });
mock(path.join(SERVER, 'modules/moduleLogBuffer'), {
    get: (id, opts) => { touched.push({ what: 'logBuffer.get', args: [id, opts] }); return []; },
});
mock(path.join(SERVER, 'stores/platformModuleStore'), {
    getState: async (id) => ({ moduleId: id, source: 'remote' }),
    getAllStates: async () => [],
    mergeSettings: async (id, patch) => { touched.push({ what: 'mergeSettings', args: [id, patch] }); return true; },
});
mock(path.join(SERVER, 'stores/userStore'), {
    getAccessAuditLog: async (params) => { touched.push({ what: 'getAccessAuditLog', args: [params] }); return []; },
});
mock(path.join(SERVER, 'auth/permissions'), { requireSuperAdmin: (req, res, next) => next() });

const router = require('./modules');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; }, setTimeout() {},
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
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

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the loader or the store');
    return res;
}

// ═══ PATCH /:id/update-policy ═══════════════════════════════════════

test('a pin nobody implements is refused instead of storing no pin at all', async () => {
    const res = await refuses({ method: 'PATCH', url: '/demo/update-policy', body: { channel: 'stable', pin: 'patch' } }, 'body.pin');
    assert.strictEqual(res.body.error, 'pin is "none", "major" or "minor".');
});

test('a capitalised channel is refused, not quietly read as stable', async () => {
    const res = await refuses({ method: 'PATCH', url: '/demo/update-policy', body: { channel: 'Beta', pin: 'none' } }, 'body.channel');
    assert.strictEqual(res.body.error, 'channel is "stable" or "beta".');
});

test('the policy a caller may set still reaches the store', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/demo/update-policy', body: { channel: 'beta', pin: 'major' } });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'mergeSettings').args[1], { updatePolicy: { channel: 'beta', pin: 'major' } });
});

test('no policy at all still means stable, unpinned — from the schema', async () => {
    const res = await dispatch({ method: 'PATCH', url: '/demo/update-policy', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body.updatePolicy, { channel: 'stable', pin: 'none' });
});

// ═══ GET /:id/logs ══════════════════════════════════════════════════

test('a log level the buffer never writes is refused, not answered with an empty list', async () => {
    const res = await refuses({ method: 'GET', url: '/demo/logs?level=warning' }, 'query.level');
    assert.ok(res.body.error.includes('warn'), res.body.error);
});

test('a limit that is not a number is refused in words', async () => {
    const res = await dispatch({ method: 'GET', url: '/demo/logs?limit=veel' });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'limit must be a number.');
    assert.deepStrictEqual(touched, []);
});

test('the level a caller may filter on still reaches the buffer', async () => {
    const res = await dispatch({ method: 'GET', url: '/demo/logs?level=error&limit=25' });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'logBuffer.get').args[1], { limit: 25, level: 'error' });
});

// ═══ The list queries ═══════════════════════════════════════════════

test('a misspelled audit filter is refused, not dropped into a wider list', async () => {
    await refuses({ method: 'GET', url: '/audit?module=demo' }, 'query');
});

test('a misspelled marketplace filter is refused, not answered with the whole catalogue', async () => {
    await refuses({ method: 'GET', url: '/marketplace?search=crm' }, 'query');
});

// ═══ POST /connect ══════════════════════════════════════════════════

test('a misspelled hub address is refused rather than connecting to the default hub', async () => {
    await refuses({ method: 'POST', url: '/connect', body: { hubURL: 'https://hub.internal' } }, 'body');
});

test('no hub address at all still means "the default hub"', async () => {
    const res = await dispatch({ method: 'POST', url: '/connect', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'connect').args[0], { hubUrl: undefined });
});

// ═══ install / update / rollback ════════════════════════════════════

test('a consent answer that is one permission, not a list, is refused', async () => {
    // It used to become `null`, so the install failed later with
    // consent_required — for permissions the operator had just accepted.
    await refuses({ method: 'POST', url: '/demo/install', body: { acceptedPermissions: 'files.read' } }, 'body.acceptedPermissions');
});

test('a force flag that is the string "true" is refused, not read as false', async () => {
    await refuses({ method: 'POST', url: '/demo/rollback', body: { version: '0.9.0', force: 'true' } }, 'body.force');
});

test('a rollback a caller may ask for still runs', async () => {
    const res = await dispatch({ method: 'POST', url: '/demo/rollback', body: { version: '0.9.0', force: true } });
    assert.strictEqual(res.statusCode, 200);
    const opts = touched.find((t) => t.what === 'rollbackTo').args[1];
    assert.strictEqual(opts.version, '0.9.0');
    assert.strictEqual(opts.force, true);
});
