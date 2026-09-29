/**
 * Unit tests for the org-health additions to connectorBootstrap:
 *
 *   1. applyNcDefaultPlanIfConfigured — the Fase 1.1 fallback chain:
 *      nc_recommended plan → (existing subscription? keep) → default org plan
 *      → community fallback. Every applied plan writes an access-audit row and
 *      emits bootstrap.plan_applied + resolves; the nothing-could-be-applied
 *      path emits bootstrap.community_fallback; failures emit
 *      bootstrap.plan_apply_failed and NEVER throw out of bootstrap.
 *
 *   2. POST /connector/status (phone-home) — tenant-JWT gated, strict body
 *      whitelist, 401s capture nothing (spam protection), ok-reports resolve
 *      connector problems, error-reports record connector.reported_error.
 *
 * Dependencies are stubbed via require-cache injection scoped to
 * connectorBootstrap.js (pattern: adminRoutes.users.authz.test.js) — no DB,
 * no fetch.
 *
 * Run: cd server && node --test auth/connectorBootstrap.orgHealth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

// ── Mutable fixtures ─────────────────────────────────────────────────
const fx = {
    ncPlan: null,             // getDefaultNcPlan() result
    existingSub: null,        // getOrgSubscription() result
    defaultPlanId: null,      // getDefaultOrgPlanId() result
    setSubThrows: false,
    calls: [],                // [name, ...args] recorder
};

function callsOf(name) {
    return fx.calls.filter(c => c[0] === name);
}

const MOCKS = {
    '../stores/userStore': {
        getDefaultNcPlan: async () => fx.ncPlan,
        getOrgSubscription: async (orgId) => { fx.calls.push(['getOrgSubscription', orgId]); return fx.existingSub; },
        getDefaultOrgPlanId: async () => fx.defaultPlanId,
        setOrgSubscription: async (orgId, data) => {
            fx.calls.push(['setOrgSubscription', orgId, data]);
            if (fx.setSubThrows) throw new Error('boom: subscription write failed');
            return true;
        },
        logAccessAudit: async (...args) => { fx.calls.push(['logAccessAudit', ...args]); },
    },
    '../stores/configStore': {
        getConfig: async () => null,
        getSecret: async () => null,
        setSecretIfAbsent: async (_k, v) => v,
    },
    './connectorJwt': {
        invalidateTenantKeyCache: () => { },
        _verifyHs256: () => { throw new Error('not used'); },
        _resolveTenant: async (token) => {
            fx.calls.push(['_resolveTenant', token]);
            return fx.resolvedTenant || null;
        },
    },
    '../services/planEntitlements': {
        applyPlanToOrg: async (...args) => { fx.calls.push(['applyPlanToOrg', ...args]); },
    },
    '../services/orgHealth': {
        problem: (code, opts) => { fx.calls.push(['problem', code, opts]); return Promise.resolve(); },
        event: (code, opts) => { fx.calls.push(['event', code, opts]); return Promise.resolve(); },
        resolve: (subject, codes, opts) => { fx.calls.push(['resolve', subject, codes, opts]); return Promise.resolve(0); },
        touchLiveness: (orgId, kind, opts) => { fx.calls.push(['touchLiveness', orgId, kind, opts]); return Promise.resolve(); },
    },
    '../utils/emailService': {
        sendNcVerificationCodeEmail: async () => ({ success: true }),
    },
    '../utils/freeEmailDomains': {
        isFreeEmailDomain: () => false,
        getEffectiveFreeEmailDomains: async () => [],
    },
    // Pass-through rate limiting — the real express-rate-limit needs req.ip
    // plumbing that a unit dispatch doesn't have.
    'express-rate-limit': (_opts) => {
        const mw = (req, res, next) => next();
        return mw;
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:connectorbootstrap-orghealth:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

// Keep the hook installed for the whole file: the /connector/status handler
// lazily requires './connectorJwt' at REQUEST time, not at load time. The
// filter is parent-scoped so nothing else in the process is affected (and
// node --test runs each file in its own process anyway).
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /auth[\\/]connectorBootstrap\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

let router;
let helpers;
let loadError = null;
try {
    router = require('./connectorBootstrap');
    helpers = router.helpers;
} catch (err) {
    loadError = err;
}

test.after(() => { Module._resolveFilename = originalResolve; });

function resetFx() {
    fx.ncPlan = null;
    fx.existingSub = null;
    fx.defaultPlanId = null;
    fx.setSubThrows = false;
    fx.resolvedTenant = null;
    fx.calls = [];
}

test('module loaded with its dependencies stubbed', () => {
    assert.equal(loadError, null, loadError && loadError.stack);
    assert.equal(typeof helpers.applyNcDefaultPlanIfConfigured, 'function');
});

// ═══ applyNcDefaultPlanIfConfigured ══════════════════════════════════

test('nc_recommended plan present → subscription + entitlements reset + audit + emits', async () => {
    resetFx();
    fx.ncPlan = { id: 'plan-nc', name: 'NC Enterprise' };
    await helpers.applyNcDefaultPlanIfConfigured('org1', 'fresh_org');

    assert.deepEqual(callsOf('setOrgSubscription')[0].slice(1), ['org1', { plan_id: 'plan-nc', status: 'active' }]);
    assert.deepEqual(callsOf('applyPlanToOrg')[0].slice(1), ['org1', 'plan-nc', { mode: 'reset' }]);

    const audit = callsOf('logAccessAudit')[0];
    assert.equal(audit[1], 'nc_default_plan_applied');
    assert.equal(audit[2], 'organization');
    assert.equal(audit[3], 'org1');
    assert.equal(audit[4], 'system:connector_bootstrap');
    assert.deepEqual(audit[6], { plan_id: 'plan-nc', source: 'fresh_org', fallback: false });
    assert.equal(audit[7], 'org1');

    const ev = callsOf('event')[0];
    assert.equal(ev[1], 'bootstrap.plan_applied');
    assert.deepEqual(ev[2].meta, { planId: 'plan-nc', fallback: false });

    const rs = callsOf('resolve')[0];
    assert.equal(rs[1], 'org1');
    assert.deepEqual(rs[2], ['bootstrap.community_fallback', 'chat.subscription_blocked']);

    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan + subscription already exists → no-op (no write, no audit, no emits)', async () => {
    resetFx();
    fx.existingSub = { plan_id: 'plan-existing', status: 'active' };
    await helpers.applyNcDefaultPlanIfConfigured('org2', 'pairing_code');

    assert.equal(callsOf('setOrgSubscription').length, 0);
    assert.equal(callsOf('applyPlanToOrg').length, 0);
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);
    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan + no subscription + default plan → fallback subscription WITHOUT applyPlanToOrg', async () => {
    resetFx();
    fx.defaultPlanId = 'plan-free';
    await helpers.applyNcDefaultPlanIfConfigured('org3', 'email_verification');

    assert.deepEqual(callsOf('setOrgSubscription')[0].slice(1), ['org3', { plan_id: 'plan-free', status: 'active' }]);
    // Fallback path is plan-defaults only — entitlements must not be reset.
    assert.equal(callsOf('applyPlanToOrg').length, 0);

    const audit = callsOf('logAccessAudit')[0];
    assert.equal(audit[1], 'nc_default_plan_applied');
    assert.deepEqual(audit[6], { plan_id: 'plan-free', source: 'email_verification', fallback: true });

    const ev = callsOf('event')[0];
    assert.equal(ev[1], 'bootstrap.plan_applied');
    assert.deepEqual(ev[2].meta, { planId: 'plan-free', fallback: true });
    assert.deepEqual(callsOf('resolve')[0][2], ['bootstrap.community_fallback', 'chat.subscription_blocked']);
    assert.equal(callsOf('problem').length, 0);
});

test('no nc plan, no subscription, no default → community_fallback problem, nothing applied', async () => {
    resetFx();
    await helpers.applyNcDefaultPlanIfConfigured('org4', 'fresh_org');

    assert.equal(callsOf('setOrgSubscription').length, 0);
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);

    const p = callsOf('problem')[0];
    assert.equal(p[1], 'bootstrap.community_fallback');
    assert.equal(p[2].orgId, 'org4');
    assert.deepEqual(p[2].meta, { source: 'fresh_org', reason: 'no_nc_recommended_plan_and_no_default' });
});

test('subscription write throws → never throws out of bootstrap, emits plan_apply_failed', async () => {
    resetFx();
    fx.ncPlan = { id: 'plan-nc', name: 'NC Enterprise' };
    fx.setSubThrows = true;
    await assert.doesNotReject(helpers.applyNcDefaultPlanIfConfigured('org5', 'fresh_org'));

    const p = callsOf('problem')[0];
    assert.equal(p[1], 'bootstrap.plan_apply_failed');
    assert.equal(p[2].orgId, 'org5');
    assert.equal(p[2].meta.source, 'fresh_org');
    // No success artefacts on the failure path.
    assert.equal(callsOf('logAccessAudit').length, 0);
    assert.equal(callsOf('event').length, 0);
});

// ═══ POST /connector/status (phone-home) ═════════════════════════════

function dispatch({ headers = {}, body = {} }) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'POST',
            url: '/connector/status',
            ip: '127.0.0.1',
            body,          // express.json skips parsing (no content-length) and keeps this
            query: {},
            params: {},
            headers,
            session: {},
            get(name) { return this.headers[String(name).toLowerCase()]; },
        };
        const res = {
            statusCode: 200,
            headers: {},
            setHeader(k, v) { this.headers[k] = v; },
            getHeader(k) { return this.headers[k]; },
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; resolve(this); return this; },
            send(b) { this.body = b; resolve(this); return this; },
            end() { resolve(this); return this; },
        };
        router(request, res, (err) => reject(err || new Error('fell through router: POST /connector/status')));
    });
}

const TOKENISH = 'aaaa.bbbb.cccc';

test('phone-home: missing bearer → 401, nothing captured', async () => {
    resetFx();
    const res = await dispatch({ headers: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(callsOf('touchLiveness').length, 0);
    assert.equal(callsOf('problem').length, 0);
    assert.equal(callsOf('resolve').length, 0);
});

test('phone-home: non-JWT-shaped token → 401, nothing captured', async () => {
    resetFx();
    const res = await dispatch({ headers: { authorization: 'Bearer not-a-jwt' } });
    assert.equal(res.statusCode, 401);
    assert.equal(callsOf('touchLiveness').length, 0);
    assert.equal(callsOf('problem').length, 0);
});

test('phone-home: unmatched tenant key → 401, nothing captured (spam protection)', async () => {
    resetFx();
    fx.resolvedTenant = null;
    const res = await dispatch({ headers: { authorization: `Bearer ${TOKENISH}` } });
    assert.equal(res.statusCode, 401);
    assert.equal(callsOf('_resolveTenant').length, 1);
    assert.equal(callsOf('touchLiveness').length, 0);
    assert.equal(callsOf('problem').length, 0);
    assert.equal(callsOf('resolve').length, 0);
});

test('phone-home: error report → 204 + liveness + connector.reported_error with whitelisted meta only', async () => {
    resetFx();
    fx.resolvedTenant = { orgId: 'org-ph', payload: { sub: 'system' } };
    const res = await dispatch({
        headers: { authorization: `Bearer ${TOKENISH}` },
        body: {
            state: 'error', category: 'network', code: 'nc_unreachable',
            connectorVersion: '0.1.40', lastAttemptAt: '2026-07-23T09:00:00Z',
            evil: 'ignored', prompt: 'ignored too',
        },
    });
    assert.equal(res.statusCode, 204);

    const tl = callsOf('touchLiveness')[0];
    assert.deepEqual(tl.slice(1), ['org-ph', 'statusReport', { connectorVersion: '0.1.40' }]);

    const p = callsOf('problem')[0];
    assert.equal(p[1], 'connector.reported_error');
    assert.equal(p[2].orgId, 'org-ph');
    assert.deepEqual(p[2].meta, {
        category: 'network', code: 'nc_unreachable', reason: 'network',
        lastAttemptAt: '2026-07-23T09:00:00Z', connectorVersion: '0.1.40',
    });
    // Non-whitelisted body fields never reach the meta.
    assert.ok(!('evil' in p[2].meta));
    assert.equal(callsOf('resolve').length, 0);
});

test('phone-home: ok report → 204 + liveness + resolves connector problems', async () => {
    resetFx();
    fx.resolvedTenant = { orgId: 'org-ph', payload: { sub: 'system' } };
    const res = await dispatch({
        headers: { authorization: `Bearer ${TOKENISH}` },
        body: { state: 'ok', connectorVersion: '0.1.40' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(callsOf('problem').length, 0);
    const rs = callsOf('resolve')[0];
    assert.equal(rs[1], 'org-ph');
    assert.deepEqual(rs[2], ['connector.reported_error', 'connector.key_divergence']);
});

test('phone-home: unknown state → 204, liveness only (report counted, nothing else)', async () => {
    resetFx();
    fx.resolvedTenant = { orgId: 'org-ph', payload: {} };
    const res = await dispatch({
        headers: { authorization: `Bearer ${TOKENISH}` },
        body: { state: 'weird' },
    });
    assert.equal(res.statusCode, 204);
    assert.equal(callsOf('touchLiveness').length, 1);
    assert.equal(callsOf('problem').length, 0);
    assert.equal(callsOf('resolve').length, 0);
});
