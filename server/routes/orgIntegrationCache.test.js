/**
 * Route-level tests — the organisation switch for keeping integration answers
 * between runs.
 *
 * The contract, and why each line of it is load-bearing:
 *   - an unconfigured org reads back OFF. This is the whole safety argument:
 *     nothing is stored until an admin says so, and a config-store that
 *     answers nothing must never be read as consent;
 *   - a corrupt or hand-rolled body cannot write an "on";
 *   - switching it OFF purges what is already stored — an "off" that left rows
 *     behind is not what anyone reads it as;
 *   - only an org admin may write, and only a member may read;
 *   - the runtime memo is dropped on save, or the change would take up to 30s.
 *
 * Run: node --test routes/orgIntegrationCache.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory mocks ────────────────────────────────────────────────────
const storeBlobs = {};
const invalidated = [];
let cacheRows = 0;
const purges = [];

const configStoreStub = {
    async getConfig(key) { return storeBlobs[key] !== undefined ? storeBlobs[key] : null; },
    async setConfig(key, value) { storeBlobs[key] = value; return true; },
};
const authStub = {
    async resolveUserOrgIds(req) {
        const orgId = req?.session?.user?.organizationId;
        return orgId ? new Set([orgId]) : new Set();
    },
};
const permissionsStub = {
    requireAuth(req, res, next) {
        if (!req.session?.isAuthenticated) return res.status(401).json({ error: 'Unauthenticated' });
        return next();
    },
    async isOrgAdminForOrg(req, orgId) {
        return req?.session?.user?.orgRole === 'org_admin'
            && req?.session?.user?.organizationId === orgId;
    },
};
const shrinks = [];
let cacheExpiredRows = 0;
let cacheBytes = 0;
let shrinkResult = 0;
const cacheStoreStub = {
    async statsForOrg() { return { entries: cacheRows, expiredEntries: cacheExpiredRows, bytes: cacheBytes }; },
    async purgeForOrg(orgId) { purges.push(orgId); const n = cacheRows; cacheRows = 0; return n; },
    async shrinkTtlForOrg(orgId, ttlSeconds) { shrinks.push([orgId, ttlSeconds]); return shrinkResult; },
};

// The policy module is REAL — normalizePolicy is the validation under test —
// with only its configStore dependency stubbed and a spy on invalidation.
const realPolicy = (() => {
    const policyPath = require.resolve('../core/automationRunner/integrationCachePolicy');
    const csPath = require.resolve('../stores/configStore');
    require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: configStoreStub };
    delete require.cache[policyPath];
    const mod = require('../core/automationRunner/integrationCachePolicy');
    return {
        ...mod,
        invalidateCachePolicy: (orgId) => { invalidated.push(orgId); mod.invalidateCachePolicy(orgId); },
    };
})();

const ROUTES_DIR = path.sep + path.join('routes');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR + path.sep)) {
        if (request === '../stores/configStore') return path.join(__dirname, '__stub_cfg_intcache__.js');
        if (request === '../auth') return path.join(__dirname, '__stub_auth_intcache__.js');
        if (request === '../auth/permissions') return path.join(__dirname, '__stub_perm_intcache__.js');
        if (request === '../stores/integrationCacheStore') return path.join(__dirname, '__stub_store_intcache__.js');
        if (request === '../core/automationRunner/integrationCachePolicy') return path.join(__dirname, '__stub_policy_intcache__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_cfg_intcache__.js': configStoreStub,
    '__stub_auth_intcache__.js': authStub,
    '__stub_perm_intcache__.js': permissionsStub,
    '__stub_store_intcache__.js': cacheStoreStub,
    '__stub_policy_intcache__.js': realPolicy,
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const express = require('express');
const router = require('./orgIntegrationCache');
const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/org-integration-cache', router);
let server;

before(() => { server = app.listen(0); });
after(() => { server?.close(); Module._resolveFilename = origResolve; delete process.env.INTEGRATION_CACHE_DISABLED; });

function request(method, pathname, body = null) {
    const { port } = server.address();
    return new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}${pathname}`, {
            method, headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8');
                let parsed = null;
                try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

const ORG_ID = 'org_test';
const KEY = `org_integration_cache_${ORG_ID}`;
const ADMIN = { isAuthenticated: true, user: { id: 'u_admin', organizationId: ORG_ID, orgRole: 'org_admin' } };
const MEMBER = { isAuthenticated: true, user: { id: 'u_member', organizationId: ORG_ID, orgRole: 'member' } };
const OUTSIDER = { isAuthenticated: true, user: { id: 'u_other', organizationId: 'org_other', orgRole: 'org_admin' } };

beforeEach(() => {
    for (const k of Object.keys(storeBlobs)) delete storeBlobs[k];
    invalidated.length = 0;
    purges.length = 0;
    shrinks.length = 0;
    cacheRows = 0;
    cacheExpiredRows = 0;
    cacheBytes = 0;
    shrinkResult = 0;
    delete process.env.INTEGRATION_CACHE_DISABLED;
    realPolicy.invalidateCachePolicy(ORG_ID);
    currentSession = ADMIN;
});

test('an unconfigured org reads back OFF', async () => {
    const res = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.enabled, false, 'nothing is stored until an admin says so');
    assert.strictEqual(res.body.configured, false, 'the screen must tell "never set" from "explicitly off"');
});

test('save round-trips and drops the runtime memo', async () => {
    const put = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 600 });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.enabled, true);
    assert.strictEqual(put.body.ttlSeconds, 600);
    assert.deepStrictEqual(invalidated, [ORG_ID]);
    assert.strictEqual(storeBlobs[KEY].enabled, true);
    assert.ok(storeBlobs[KEY].updatedBy, 'who turned it on is part of the record');

    const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.strictEqual(get.body.enabled, true);
    assert.strictEqual(get.body.configured, true);
});

test('only a literal true turns it on — and a non-boolean changes nothing at all', async () => {
    // A body from a stale client, a form that posts "true", a JSON null — none
    // of these are an organisation deciding to store third-party payloads.
    // They used to be read as an OFF, and an OFF purges: a client that meant
    // "on" deleted every stored answer. Now they are refused and write nothing.
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true });
    cacheRows = 9;
    purges.length = 0;
    for (const value of ['true', 1, 'on', {}, [], null, undefined]) {
        const put = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: value });
        assert.strictEqual(put.status, 400, `${JSON.stringify(value)} is refused`);
    }
    assert.deepStrictEqual(purges, [], 'no refused save purged anything');
    assert.strictEqual(storeBlobs[KEY].enabled, true, 'and the stored decision is untouched');
});

test('the ttl is clamped, never rejected into a broken row', async () => {
    const tooLong = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 999999 });
    assert.strictEqual(tooLong.body.ttlSeconds, realPolicy.MAX_TTL_SECONDS);
    const tooShort = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 1 });
    assert.strictEqual(tooShort.body.ttlSeconds, realPolicy.MIN_TTL_SECONDS);
    // A number out of range has an intent to clamp towards; 'soon' has none.
    // It used to be saved as the 300s default under a 200.
    const nonsense = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 'soon' });
    assert.strictEqual(nonsense.status, 400);
    assert.strictEqual(storeBlobs[KEY].ttlSeconds, realPolicy.MIN_TTL_SECONDS, 'the refused save changed nothing');
});

test('switching it off forgets what was already stored', async () => {
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true });
    cacheRows = 42;
    const off = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: false });
    assert.strictEqual(off.body.enabled, false);
    assert.deepStrictEqual(purges, [ORG_ID], 'an "off" that left rows behind is not what anyone reads it as');
    assert.strictEqual(off.body.purged, 42, 'and the admin is told what actually went');
});

test('turning it ON does not purge', async () => {
    cacheRows = 5;
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true });
    assert.deepStrictEqual(purges, []);
});

test('an admin can forget everything without changing the policy', async () => {
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true });
    cacheRows = 7;
    const res = await request('DELETE', `/api/org-integration-cache/${ORG_ID}/entries`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.purged, 7);
    const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.strictEqual(get.body.enabled, true, 'the policy is untouched');
});

test('an ordinary member may read but not write', async () => {
    currentSession = MEMBER;
    assert.strictEqual((await request('GET', `/api/org-integration-cache/${ORG_ID}`)).status, 200);
    assert.strictEqual((await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true })).status, 403);
    assert.strictEqual((await request('DELETE', `/api/org-integration-cache/${ORG_ID}/entries`)).status, 403);
});

test('another organisation\'s admin gets nothing', async () => {
    currentSession = OUTSIDER;
    assert.strictEqual((await request('GET', `/api/org-integration-cache/${ORG_ID}`)).status, 403);
    assert.strictEqual((await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true })).status, 403);
});

test('an unauthenticated caller gets 401', async () => {
    currentSession = { isAuthenticated: false };
    assert.strictEqual((await request('GET', `/api/org-integration-cache/${ORG_ID}`)).status, 401);
});

test('a shortened window reaches the answers already stored', async () => {
    // expires_at is stamped at WRITE time, so without this the rows already in
    // the table keep the 60-minute window the admin has just replaced with 5,
    // and "I turned it down because the data was stale" does nothing for
    // another 59 minutes.
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 3600 });
    shrinks.length = 0;
    shrinkResult = 12;
    const res = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 300 });
    assert.deepStrictEqual(shrinks, [[ORG_ID, 300]]);
    assert.strictEqual(res.body.shrunk, 12, 'and the admin is told how many were pulled back');
});

test('switching it OFF purges instead of shrinking', async () => {
    // There is nothing left to shorten, and asking the store to rewrite rows it
    // has just deleted would be a second statement doing nothing.
    cacheRows = 3;
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: false, ttlSeconds: 300 });
    assert.deepStrictEqual(shrinks, []);
    assert.deepStrictEqual(purges, [ORG_ID]);
});

test('expired-but-present rows are reported, not hidden', async () => {
    // The prune runs hourly. Reporting only live entries told an org it held
    // nothing while thousands of rows sat in the table between passes — and
    // the screen hides its purge button on exactly that number.
    cacheRows = 2;
    cacheExpiredRows = 40;
    cacheBytes = 4096;
    const res = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.strictEqual(res.body.entries, 2);
    assert.strictEqual(res.body.expiredEntries, 40);
    assert.strictEqual(res.body.bytes, 4096);
});

test('the env kill switch is reported, and beats a stored ON', async () => {
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true });
    process.env.INTEGRATION_CACHE_DISABLED = '1';
    const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.strictEqual(get.body.killSwitch, true, 'a toggle that silently does nothing is worse than no toggle');
    // The stored row still says on — the operator switched off the BOX, not the
    // organisation's decision — but the runtime resolver refuses regardless.
    realPolicy.invalidateCachePolicy(ORG_ID);
    const effective = await realPolicy.resolveCachePolicy(ORG_ID);
    assert.strictEqual(effective.enabled, false);
});

// ── the two scope ticks ─────────────────────────────────────────────────────
//
// One decision, one config row, two ticks inside it. Two KEYS would let an org
// sit half-on with nobody able to see which half; a reworded screen would
// silently widen a consent an admin gave about connected apps to cover any web
// address a routine author types in.

test('scopes round-trip, and a missing body writes the safe pair', async () => {
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, { enabled: true, ttlSeconds: 300 });
    const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.deepStrictEqual(get.body.scopes, { integration: true, http: false },
        'an admin who said yes to app look-ups did not say yes to arbitrary outbound HTTP');
});

test('outbound HTTP is only ever enabled by a literal true', async () => {
    for (const http of ['true', 1, 'on', 'yes', {}, []]) {
        const put = await request('PUT', `/api/org-integration-cache/${ORG_ID}`, {
            enabled: true, ttlSeconds: 300, scopes: { integration: true, http },
        });
        assert.strictEqual(put.status, 400, `${JSON.stringify(http)} is refused, not read as a no`);
        const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
        assert.strictEqual(get.body.scopes.http, false, JSON.stringify(http));
    }
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, {
        enabled: true, ttlSeconds: 300, scopes: { integration: true, http: true },
    });
    assert.strictEqual((await request('GET', `/api/org-integration-cache/${ORG_ID}`)).body.scopes.http, true);
});

test('the app-look-up half can be switched off on its own', async () => {
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, {
        enabled: true, ttlSeconds: 300, scopes: { integration: false, http: true },
    });
    const get = await request('GET', `/api/org-integration-cache/${ORG_ID}`);
    assert.deepStrictEqual(get.body.scopes, { integration: false, http: true });
});

test('a saved scope reaches the RUNTIME resolver, not just the screen', async () => {
    // The tick has to gate a real code path; a settings row nothing reads is
    // exactly the silent no-op this whole feature is built against.
    await request('PUT', `/api/org-integration-cache/${ORG_ID}`, {
        enabled: true, ttlSeconds: 300, scopes: { integration: true, http: true },
    });
    realPolicy.invalidateCachePolicy(ORG_ID);
    const effective = await realPolicy.resolveCachePolicy(ORG_ID);
    assert.strictEqual(effective.scopes.http, true);
});
