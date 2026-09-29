/**
 * Route-level tests — organisation conversation-memory (compaction) settings.
 *
 * The contract this pins down:
 *   - an unconfigured org reads back compaction OFF (the product default);
 *   - a save round-trips and is readable by any member;
 *   - only an org admin may write;
 *   - the runtime memo is dropped on save, so the change applies to the very
 *     next message rather than up to 30 s later.
 *
 * Run: node --test routes/orgAiContext.test.js
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');
const http = require('http');

// ── In-memory mocks ────────────────────────────────────────────────────
const storeBlobs = {};
const invalidated = [];

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

// The route's own policy module is real (it owns normalizePolicy, which is the
// validation under test) — only its configStore dependency is stubbed, plus a
// spy on the cache invalidation.
const realPolicy = (() => {
    const policyPath = require.resolve('../core/llm/contextPolicy');
    const csPath = require.resolve('../stores/configStore');
    require.cache[csPath] = { id: csPath, filename: csPath, loaded: true, exports: configStoreStub };
    delete require.cache[policyPath];
    const mod = require('../core/llm/contextPolicy');
    return {
        ...mod,
        invalidateContextPolicy: (orgId) => { invalidated.push(orgId); mod.invalidateContextPolicy(orgId); },
    };
})();

const ROUTES_DIR = path.sep + path.join('routes');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && parent.filename && parent.filename.includes(ROUTES_DIR + path.sep)) {
        if (request === '../stores/configStore') return path.join(__dirname, '__stub_cfg_aictx__.js');
        if (request === '../auth') return path.join(__dirname, '__stub_auth_aictx__.js');
        if (request === '../auth/permissions') return path.join(__dirname, '__stub_perm_aictx__.js');
        if (request === '../core/llm/contextPolicy') return path.join(__dirname, '__stub_policy_aictx__.js');
    }
    return origResolve.call(this, request, parent, ...rest);
};
const stubExports = {
    '__stub_cfg_aictx__.js': configStoreStub,
    '__stub_auth_aictx__.js': authStub,
    '__stub_perm_aictx__.js': permissionsStub,
    '__stub_policy_aictx__.js': realPolicy,
};
for (const [fname, exp] of Object.entries(stubExports)) {
    const full = path.join(__dirname, fname);
    require.cache[full] = { id: full, filename: full, loaded: true, exports: exp };
}

const express = require('express');
const router = require('./orgAiContext');
const app = express();
app.use(express.json());
let currentSession = null;
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/org-ai-context', router);
let server;

before(() => { server = app.listen(0); });
after(() => { server?.close(); Module._resolveFilename = origResolve; });

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
const KEY = `org_ai_context_${ORG_ID}`;
const ADMIN = { isAuthenticated: true, user: { id: 'u_admin', organizationId: ORG_ID, orgRole: 'org_admin' } };
const MEMBER = { isAuthenticated: true, user: { id: 'u_member', organizationId: ORG_ID, orgRole: 'member' } };
const OUTSIDER = { isAuthenticated: true, user: { id: 'u_other', organizationId: 'org_other', orgRole: 'org_admin' } };

beforeEach(() => {
    for (const k of Object.keys(storeBlobs)) delete storeBlobs[k];
    invalidated.length = 0;
    realPolicy.invalidateContextPolicy(ORG_ID);
    currentSession = ADMIN;
});

test('an unconfigured org reads back compaction OFF', async () => {
    const res = await request('GET', `/api/org-ai-context/${ORG_ID}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.compactionEnabled, false);
    assert.strictEqual(res.body.configured, false, 'the SPA must be able to tell "never set" from "explicitly off"');
});

test('save round-trips and drops the runtime memo', async () => {
    const put = await request('PUT', `/api/org-ai-context/${ORG_ID}`, { compactionEnabled: true });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.compactionEnabled, true);
    assert.deepStrictEqual(invalidated, [ORG_ID],
        'without this the admin would keep seeing the old behaviour for up to 30s');

    realPolicy.invalidateContextPolicy(ORG_ID);
    assert.strictEqual((await realPolicy.resolveContextPolicy(ORG_ID)).compactionEnabled, true);

    const get = await request('GET', `/api/org-ai-context/${ORG_ID}`);
    assert.strictEqual(get.body.compactionEnabled, true);
    assert.strictEqual(get.body.configured, true);
});

test('the context budget percentage round-trips and is clamped, not rejected', async () => {
    const put = await request('PUT', `/api/org-ai-context/${ORG_ID}`, {
        compactionEnabled: false, contextBudgetPercent: 50,
    });
    assert.strictEqual(put.status, 200);
    assert.strictEqual(put.body.contextBudgetPercent, 50);
    assert.strictEqual((await request('GET', `/api/org-ai-context/${ORG_ID}`)).body.contextBudgetPercent, 50);

    // Out of range is an admin typo, not an attack — clamp rather than 400 and
    // lose the rest of their edit. (The switch travels with every save: a body
    // without it is refused, see orgAiContext.validation.test.js.)
    const tooHigh = await request('PUT', `/api/org-ai-context/${ORG_ID}`, {
        compactionEnabled: false, contextBudgetPercent: 500,
    });
    assert.strictEqual(tooHigh.status, 200);
    assert.strictEqual(tooHigh.body.contextBudgetPercent, 95);
});

test('GET carries the context windows and the allowed range for the slider', async () => {
    const res = await request('GET', `/api/org-ai-context/${ORG_ID}`);
    assert.ok(Array.isArray(res.body.contextWindowExamples) && res.body.contextWindowExamples.length >= 2,
        'the SPA must not need its own copy of the context-window table');
    assert.ok(res.body.contextWindowExamples.every(e => e.label && e.contextWindow > 0));
    assert.deepStrictEqual(res.body.contextBudgetRange, { min: 25, max: 95 });
});

test('a hand-rolled body cannot write unusable tunables', async () => {
    const res = await request('PUT', `/api/org-ai-context/${ORG_ID}`, {
        compactionEnabled: true, compactionThreshold: 1, recentWindow: 100000,
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.compactionThreshold >= 4);
    assert.ok(res.body.recentWindow < res.body.compactionThreshold);
    assert.ok(storeBlobs[KEY].updatedAt, 'the row records when and by whom');
    assert.strictEqual(storeBlobs[KEY].updatedBy, 'u_admin');
});

test('a non-admin member can read but not write', async () => {
    currentSession = MEMBER;
    assert.strictEqual((await request('GET', `/api/org-ai-context/${ORG_ID}`)).status, 200);
    const put = await request('PUT', `/api/org-ai-context/${ORG_ID}`, { compactionEnabled: true });
    assert.strictEqual(put.status, 403);
    assert.strictEqual(storeBlobs[KEY], undefined);
});

test('another organisation is neither readable nor writable', async () => {
    currentSession = OUTSIDER;
    assert.strictEqual((await request('GET', `/api/org-ai-context/${ORG_ID}`)).status, 403);
    assert.strictEqual((await request('PUT', `/api/org-ai-context/${ORG_ID}`, { compactionEnabled: true })).status, 403);
});

test('an unauthenticated request is rejected', async () => {
    currentSession = null;
    assert.strictEqual((await request('GET', `/api/org-ai-context/${ORG_ID}`)).status, 401);
    assert.strictEqual((await request('PUT', `/api/org-ai-context/${ORG_ID}`, {})).status, 401);
});
