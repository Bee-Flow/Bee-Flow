/**
 * /api/admin/modules — authz + side-effect tests.
 *
 * The router is exercised over real HTTP (express + ephemeral port) with the
 * REAL modules runtime underneath; only the leaf dependencies are stubbed via
 * require.cache: db (records every SQL text — must stay EMPTY here), the module
 * catalog (a synthetic built-in 'demo_module' — the real catalog ships none now
 * that Security Scan is a downloadable .bfmod), platformModuleStore (in-memory),
 * the module store (initDB spy), userStore (audit spy) and sessionCache (bust spy).
 *
 * Verifies:
 *   - 401 unauthenticated, 403 non-super-admin (org admins with the 'all'
 *     perm must NOT pass), 200 super-admin — on all three endpoints
 *   - import runs the module store's initDB and writes the audit row
 *   - remove is non-destructive: no SQL at all reaches the db layer (in
 *     particular no DROP/DELETE/TRUNCATE against security tables)
 *
 * Run: node --test routes/admin/modules.authz.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const Module = require('module');

process.env.NODE_ENV = 'test';

function mock(request, exports) {
    const p = require.resolve(request);
    require.cache[p] = new Module(p);
    require.cache[p].exports = exports;
    require.cache[p].loaded = true;
}

// ── db stub — records every statement; nothing here should ever run SQL ────
const executedSql = [];
const record = async (sql) => { executedSql.push(String(sql)); return { rows: [], rowCount: 0 }; };
mock('../../db', {
    exec: record,
    run: record,
    getOne: async (sql) => { executedSql.push(String(sql)); return null; },
    getAll: async (sql) => { executedSql.push(String(sql)); return []; },
    getClient: async () => ({ query: record, release() {} }),
});

// ── Synthetic built-in module catalog ───────────────────────────────────────
// The real catalog ships no built-in modules now that Security Scan is a
// downloadable .bfmod. 'demo_module' stands in as the built-in the router
// imports/removes. It reuses the real 'meeting_notes' beta capability so the
// wire-contract capability projection (id + kind:'beta') resolves through the
// real registry, and points its store at reminderStore (an arbitrary existing
// store) purely so importModule can require + initDB() it.
const CATALOG = [{
    id: 'demo_module', name: 'Demo Module', icon: 'box', category: 'Studio',
    version: '1.0.0', description: 'synthetic built-in for authz tests',
    available: true, defaultImported: true,
    capabilityIds: ['meeting_notes'],
    storeModules: [{ name: 'demoStore', file: './stores/reminderStore' }],
    requirements: { docker: true, images: ['img-x'], env: ['X_*'] },
}];
mock('../../modules/catalog', {
    MODULES: CATALOG,
    listModules: () => CATALOG,
    getModule: (id) => CATALOG.find(m => m.id === id) || null,
    capabilityToModuleMap: () => new Map(CATALOG.flatMap(m => (m.capabilityIds || []).map(c => [c, m.id]))),
});

// ── platformModuleStore stub (in-memory) ────────────────────────────────────
const stateRows = new Map();
mock('../../stores/platformModuleStore', {
    initDB: async () => {},
    getAllStates: async () => [...stateRows.values()].map(r => ({ ...r })),
    getState: async (id) => (stateRows.get(id) ? { ...stateRows.get(id) } : null),
    setImported: async (id, { actorId = null, version = null } = {}) => {
        const row = { moduleId: id, status: 'imported', version, importedAt: new Date().toISOString(), importedBy: actorId };
        stateRows.set(id, row);
        return { ...row };
    },
    setRemoved: async (id, { actorId = null } = {}) => {
        const row = { ...(stateRows.get(id) || {}), moduleId: id, status: 'removed', removedAt: new Date().toISOString(), removedBy: actorId };
        stateRows.set(id, row);
        return { ...row };
    },
});

// ── module store stub — ONLY initDB; any other touch would throw ───────────
let initDbCalls = 0;
mock('../../stores/reminderStore', {
    initDB: async () => { initDbCalls++; },
});

// ── audit + session-bust spies ──────────────────────────────────────────────
const auditCalls = [];
mock('../../stores/userStore', {
    logAccessAudit: async (...args) => { auditCalls.push(args); },
});
const bustCalls = [];
mock('../../auth/sessionCache', {
    bustSessionsForUser: async (userId) => { bustCalls.push(userId); return 1; },
    bustSessionsForOrg: async () => 0,
});

// ── Hub-side stubs (deterministic; toggled per test) ───────────────────────
let installing = false;
let purchaseThrows = null;   // e.g. { code: 'not_entitled' }
mock('../../modules/hubClient', {
    getConnection: async () => ({ connected: true, hubUrl: 'http://hub.test', installId: 'inst_1' }),
    connect: async ({ hubUrl } = {}) => ({ connected: true, hubUrl: hubUrl || 'http://hub.test' }),
    disconnect: async () => ({ ok: true }),
    createPurchase: async () => {
        if (purchaseThrows) throw Object.assign(new Error('purchase'), purchaseThrows);
        return { status: 'pending', checkout_url: 'http://pay/x', purchase_id: 'pur_1' };
    },
});
mock('../../modules/remoteCatalog', {
    isRemoteRow: () => false,
    isEntitled: () => false,
    listMarketplace: async () => ({ modules: [{ id: 'acme', prices: [{ price_id: 'p1' }] }], stale: false }),
});
mock('../../modules/packageLoader', {
    installFromHub: async () => ({ ok: true }),
    isInstalling: () => installing,
    getInstallProgress: () => (installing ? { phase: 'downloading', pct: 20 } : null),
    updateModule: async () => ({ ok: true, version: '2.0.0', requiresRestart: false }),
    // remote import/remove delegation is unused here (built-in demo_module).
    activate: async () => ({ ok: true }),
    deactivate: async () => ({ ok: true }),
});
mock('../../modules/entitlementRefresh', {
    tick: async () => {},
});

const express = require('express');
const modulesRouter = require('./modules');

let server, baseUrl;
let session = null; // per-request session injected below

before(async () => {
    const app = express();
    app.use((req, res, next) => { req.session = session; next(); });
    app.use('/api/admin/modules', modulesRouter);
    server = http.createServer(app);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server && server.close());

async function call(method, path) {
    const res = await fetch(`${baseUrl}${path}`, { method });
    return { status: res.status, body: await res.json().catch(() => null) };
}

async function callJson(method, path, body) {
    const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body != null ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
}

const SUPER_ADMIN = { isAdmin: true, user: { id: 'admin1', role: 'admin' } };
// An org admin holding the 'all' permission — requireAdmin-style guards admit
// this; the module surface must NOT.
const ORG_ADMIN = { isAdmin: false, user: { id: 'orgadmin1', role: 'user', permissions: ['all'] } };

test('401 unauthenticated on all three endpoints', async () => {
    session = null;
    assert.strictEqual((await call('GET', '/api/admin/modules')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/demo_module/import')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/demo_module/remove')).status, 401);
});

test('403 non-super-admin on all three endpoints', async () => {
    session = ORG_ADMIN;
    assert.strictEqual((await call('GET', '/api/admin/modules')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/modules/demo_module/import')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/modules/demo_module/remove')).status, 403);
});

test('GET 200 super-admin returns the wire-contract rows', async () => {
    session = SUPER_ADMIN;
    const { status, body } = await call('GET', '/api/admin/modules');
    assert.strictEqual(status, 200);
    assert.ok(Array.isArray(body.modules));
    const row = body.modules.find(m => m.id === 'demo_module');
    assert.ok(row, 'built-in demo_module listed');
    assert.strictEqual(row.status, 'imported');   // grandfathered default
    assert.strictEqual(row.source, 'default');
    assert.strictEqual(row.available, true);
    assert.strictEqual(row.importedAt, null);
    assert.ok(Array.isArray(row.requirements) && row.requirements.every(r => 'id' in r && 'label' in r && 'met' in r));
    assert.strictEqual(typeof row.requirementsMet, 'boolean');
    assert.deepStrictEqual(row.capabilities.map(c => c.id), ['meeting_notes']);
    assert.strictEqual(row.capabilities[0].kind, 'beta');
});

test('unknown module id ⇒ 404 not_found', async () => {
    session = SUPER_ADMIN;
    const imp = await call('POST', '/api/admin/modules/nope/import');
    assert.strictEqual(imp.status, 404);
    assert.deepStrictEqual(imp.body, { error: 'not_found' });
    const rem = await call('POST', '/api/admin/modules/nope/remove');
    assert.strictEqual(rem.status, 404);
    assert.deepStrictEqual(rem.body, { error: 'not_found' });
});

test('import: 200, runs the module store initDB, writes audit, busts actor sessions', async () => {
    session = SUPER_ADMIN;
    const before = initDbCalls;
    const { status, body } = await call('POST', '/api/admin/modules/demo_module/import');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.module.status, 'imported');
    assert.strictEqual(body.module.source, 'explicit');
    assert.strictEqual(body.module.importedBy, 'admin1');
    assert.strictEqual(initDbCalls, before + 1, 'store migration must run on import');
    const audit = auditCalls[auditCalls.length - 1];
    assert.deepStrictEqual(audit.slice(0, 4), ['platform.module.import', 'platform_module', 'demo_module', 'admin1']);
    assert.strictEqual(bustCalls[bustCalls.length - 1], 'admin1');
});

test('remove: 200, non-destructive — zero SQL reaches the db layer', async () => {
    session = SUPER_ADMIN;
    executedSql.length = 0;
    const { status, body } = await call('POST', '/api/admin/modules/demo_module/remove');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(body.module.status, 'removed');
    // All persistence went through the stubbed stores — nothing may have hit
    // raw SQL, so in particular no DROP/DELETE/TRUNCATE on a module's tables.
    assert.deepStrictEqual(executedSql, []);
    const audit = auditCalls[auditCalls.length - 1];
    assert.strictEqual(audit[0], 'platform.module.remove');
    // ...and the route now 404s for everyone (concealment gate contract is
    // covered in modules/moduleRegistry.test.js; here we just confirm state).
    const list = await call('GET', '/api/admin/modules');
    assert.strictEqual(list.body.modules.find(m => m.id === 'demo_module').status, 'removed');
});

// ── Hub / marketplace endpoints ────────────────────────────────────────────
test('401 unauthenticated on the Hub endpoints', async () => {
    session = null;
    assert.strictEqual((await call('GET', '/api/admin/modules/marketplace')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/connect')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/disconnect')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/acme/install')).status, 401);
    assert.strictEqual((await call('POST', '/api/admin/modules/entitlements/refresh')).status, 401);
});

test('403 non-super-admin on the Hub endpoints', async () => {
    session = ORG_ADMIN;
    assert.strictEqual((await call('GET', '/api/admin/modules/marketplace')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/modules/connect')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/modules/acme/install')).status, 403);
    assert.strictEqual((await call('POST', '/api/admin/modules/acme/purchase')).status, 403);
});

test('GET /marketplace 200 super-admin returns connection + rows', async () => {
    session = SUPER_ADMIN;
    const { status, body } = await call('GET', '/api/admin/modules/marketplace');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.connected, true);
    assert.strictEqual(body.hubUrl, 'http://hub.test');
    assert.ok(Array.isArray(body.modules) && body.modules[0].id === 'acme');
});

test('POST /connect and /disconnect', async () => {
    session = SUPER_ADMIN;
    const c = await callJson('POST', '/api/admin/modules/connect', { hubUrl: 'http://hub.test' });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.body.ok, true);
    assert.strictEqual(c.body.connection.connected, true);
    const d = await call('POST', '/api/admin/modules/disconnect');
    assert.strictEqual(d.status, 200);
    assert.strictEqual(d.body.ok, true);
});

test('POST /:id/install returns 202, and 409 while an install is in progress', async () => {
    session = SUPER_ADMIN;
    installing = false;
    const ok = await call('POST', '/api/admin/modules/acme/install');
    assert.strictEqual(ok.status, 202);
    assert.strictEqual(ok.body.ok, true);

    installing = true;
    const busy = await call('POST', '/api/admin/modules/acme/install');
    assert.strictEqual(busy.status, 409);
    assert.strictEqual(busy.body.error, 'install_in_progress');

    // install-progress reflects the in-flight install, 404 otherwise
    const prog = await call('GET', '/api/admin/modules/acme/install-progress');
    assert.strictEqual(prog.status, 200);
    assert.strictEqual(prog.body.phase, 'downloading');
    installing = false;
    const none = await call('GET', '/api/admin/modules/acme/install-progress');
    assert.strictEqual(none.status, 404);
});

test('POST /:id/purchase maps a pending checkout and a not_entitled HubError (402)', async () => {
    session = SUPER_ADMIN;
    purchaseThrows = null;
    const pending = await call('POST', '/api/admin/modules/acme/purchase');
    assert.strictEqual(pending.status, 200);
    assert.strictEqual(pending.body.checkoutUrl, 'http://pay/x');
    assert.strictEqual(pending.body.purchaseId, 'pur_1');

    purchaseThrows = { code: 'not_entitled' };
    const denied = await call('POST', '/api/admin/modules/acme/purchase');
    assert.strictEqual(denied.status, 402);
    assert.strictEqual(denied.body.error, 'not_entitled');
    purchaseThrows = null;
});

test('POST /entitlements/refresh returns entitledModuleIds', async () => {
    session = SUPER_ADMIN;
    const { status, body } = await call('POST', '/api/admin/modules/entitlements/refresh');
    assert.strictEqual(status, 200);
    assert.strictEqual(body.ok, true);
    assert.ok(Array.isArray(body.entitledModuleIds));
});
