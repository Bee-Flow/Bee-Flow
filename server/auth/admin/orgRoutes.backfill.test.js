/**
 * POST/GET /organizations/:id/encryption/backfill (auth/admin/orgRoutes.js).
 * Run: cd server && node --test auth/admin/orgRoutes.backfill.test.js
 */
'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const h = require('../../core/http/routeHarness');

let adminOf = new Set(['orgA']);
let orgTier = 'managed';
const audits = [];
const started = [];
let release;

h.recordDb();
h.openGates({ isOrgAdminForOrg: async (req, id) => adminOf.has(id) });
// Same shared objects the router requires, patched in place (no module-system mocks).
const userStore = require('../../stores/userStore');
userStore.getOrganization = async (id) => ({ id, name: 'Acme', encryption_tier: orgTier });
userStore.logAccessAudit = async (...a) => { audits.push(a); };

const router = require('./orgRoutes');
const job = require('../../stores/encryptionBackfillJob');
test.after(() => { job._reset(); });

// The real engine (stores/encryptionBackfill.js) is injected through the job store's seam.
const engine = async (orgId, opts) => {
    started.push({ orgId, dryRun: opts.dryRun });
    await new Promise((r) => { release = r; });
    return { orgId, tier: 'managed', surfaces: { messages: { encrypted: 2, skipped: 0, noKey: 0, failed: 0 } } };
};

const dispatch = h.dispatcher(router, { session: () => ({ user: { id: 'adm' } }) });

const url = (id = 'orgA') => `/organizations/${id}/encryption/backfill`;
const tick = () => new Promise((r) => setImmediate(r));

test.beforeEach(async () => {
    if (release) { release(); release = undefined; await tick(); await tick(); }
    job._reset(); job._setDefaultBackfillOrg(engine);
    adminOf = new Set(['orgA']); orgTier = 'managed';
    audits.length = 0; started.length = 0;
});

test('admin starts a run: 202, running, audited', async () => {
    const res = await dispatch({ method: 'POST', url: url(), body: { dryRun: true } });
    assert.strictEqual(res.statusCode, 202, JSON.stringify(res.body));
    assert.strictEqual(res.body.status, 'running');
    assert.strictEqual(res.body.dryRun, true);
    await tick();
    assert.deepStrictEqual(started, [{ orgId: 'orgA', dryRun: true }]);
    assert.strictEqual(audits[0][0], 'org.encryption.backfill');
    const got = await dispatch({ method: 'GET', url: url() });
    assert.strictEqual(got.statusCode, 200);
    assert.strictEqual(got.body.status, 'running');
    release(); await tick(); await tick();
    assert.strictEqual((await dispatch({ method: 'GET', url: url() })).body.status, 'done');
});

test('GET of an org that never ran is idle', async () => {
    const res = await dispatch({ method: 'GET', url: url() });
    assert.strictEqual(res.body.status, 'idle');
});

test('a non-admin and an admin of another org get 403 on both routes, nothing starts', async () => {
    adminOf = new Set(['orgB']);
    const post = await dispatch({ method: 'POST', url: url(), body: { dryRun: false } });
    const get = await dispatch({ method: 'GET', url: url() });
    assert.strictEqual(post.statusCode, 403);
    assert.strictEqual(get.statusCode, 403);
    adminOf = new Set();
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: { dryRun: false } })).statusCode, 403);
    assert.deepStrictEqual(started, []);
});

test('tier none is refused with 409', async () => {
    orgTier = 'none';
    const res = await dispatch({ method: 'POST', url: url(), body: { dryRun: false } });
    assert.strictEqual(res.statusCode, 409);
    assert.deepStrictEqual(started, []);
});

test('a second start while running is refused with 409', async () => {
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: { dryRun: true } })).statusCode, 202);
    const res = await dispatch({ method: 'POST', url: url(), body: { dryRun: false } });
    assert.strictEqual(res.statusCode, 409);
});

test('zk is allowed; bad bodies are 400', async () => {
    orgTier = 'zk';
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: { dryRun: true } })).statusCode, 202);
    job._reset(); job._setDefaultBackfillOrg(engine);
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: {} })).statusCode, 400);
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: { dryRun: 'yes' } })).statusCode, 400);
    assert.strictEqual((await dispatch({ method: 'POST', url: url(), body: { dryRun: true, x: 1 } })).statusCode, 400);
});
