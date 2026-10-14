/**
 * Unit tests for the org-health additions to connectorBootstrap:
 *
 *   1. applyNcDefaultPlanIfConfigured: its tests live next to it, in
 *      connector/provisioning.test.js. Here only that the router still
 *      exports it.
 *
 *   2. POST /connector/status (phone-home) — tenant-JWT gated, strict body
 *      whitelist, 401s capture nothing (spam protection), ok-reports resolve
 *      connector problems, error-reports record connector.reported_error.
 *
 * Dependencies are stubbed via require-cache injection scoped to
 * connectorBootstrap.js and the connector/ modules it is built from
 * (pattern: adminRoutes.users.authz.test.js) — no DB, no fetch.
 *
 * Run: cd server && node --test auth/connectorBootstrap.orgHealth.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');

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
        // Verification-code send paths (resend / retarget): the per-pendingId cap.
        resetNcVerificationCode: async (id) => { fx.calls.push(['resetNcVerificationCode', id]); return fx.sendResult; },
        retargetNcVerification: async (id) => { fx.calls.push(['retargetNcVerification', id]); return fx.sendResult; },
        getPendingNcBinding: async () => fx.pendingRow,
        getUserByEmail: async () => null,
        findUnboundOrgByEmailDomain: async () => ({ id: 'org-v' }),
        getOrganization: async (id) => ({ id, name: 'Acme' }),
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
        sendNcVerificationCodeEmail: async (args) => { fx.calls.push(['sendNcVerificationCodeEmail', args]); return { success: true }; },
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

// Keyed by the file a request resolves to, so one stub serves both
// connectorBootstrap.js ('../stores/userStore') and the connector/ modules it
// is split into ('../../stores/userStore').
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:connectorbootstrap-orghealth:${request}`;
    MOCK_IDS[require.resolve(request.startsWith('.') ? path.join(__dirname, request) : request)] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}

// Keep the hook installed for the whole file: the /connector/status handler
// lazily requires './connectorJwt' at REQUEST time, not at load time. The
// filter is parent-scoped so nothing else in the process is affected (and
// node --test runs each file in its own process anyway).
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = originalResolve.call(this, request, parent, ...rest);
    if (parent && /auth[\\/](connectorBootstrap|connector[\\/][A-Za-z]+)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, resolved)) {
        return MOCK_IDS[resolved];
    }
    return resolved;
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
    fx.sendResult = null;
    fx.pendingRow = null;
    fx.calls = [];
}

test('module loaded with its dependencies stubbed', () => {
    assert.equal(loadError, null, loadError && loadError.stack);
    assert.equal(typeof helpers.applyNcDefaultPlanIfConfigured, 'function');
});


// ═══ POST /connector/status (phone-home) ═════════════════════════════

function dispatch({ headers = {}, body = {}, url = '/connector/status' }) {
    return new Promise((resolve, reject) => {
        const request = {
            method: 'POST',
            url,
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
        router(request, res, (err) => reject(err || new Error(`fell through router: POST ${url}`)));
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

// ═══ Verification code resend / retarget: capped per pendingId ═══════════
// The store counts sends and guesses per pending row (ncBindings.js); once that
// budget is spent the route answers 429 and mails nothing, whatever the IP.

const SENT_ROW = { orgId: 'org-v', verificationEmail: 'admin@acme.test', ncAdminEmail: 'admin@acme.test', expiresAt: '2026-10-13T12:00:00.000Z' };

test('resend: a spent per-pendingId budget answers 429 and sends no mail', async () => {
    resetFx();
    fx.sendResult = { status: 'too_many' };
    const res = await dispatch({ url: '/connector/bootstrap/pending/p1/resend' });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'too_many_code_requests');
    assert.equal(callsOf('sendNcVerificationCodeEmail').length, 0);
});

test('resend: not a pending verification stays 410 expired', async () => {
    resetFx();
    fx.sendResult = { status: 'not_eligible' };
    const res = await dispatch({ url: '/connector/bootstrap/pending/p1/resend' });
    assert.equal(res.statusCode, 410);
    assert.deepEqual(res.body, { status: 'expired', code: 'expired' });
});

test('resend: within budget mails the new code and answers as before', async () => {
    resetFx();
    fx.sendResult = { status: 'ok', row: SENT_ROW };
    const res = await dispatch({ url: '/connector/bootstrap/pending/p1/resend' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.expiresAt, SENT_ROW.expiresAt);
    assert.equal(res.body.emailSent, true);
    assert.equal(callsOf('sendNcVerificationCodeEmail')[0][1].to, 'admin@acme.test');
});

test('retarget: a spent per-pendingId budget answers 429 and sends no mail', async () => {
    resetFx();
    fx.pendingRow = { orgId: 'org-v', hasVerification: true, status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    fx.sendResult = { status: 'too_many' };
    const res = await dispatch({ url: '/connector/bootstrap/pending/p1/retarget', body: { email: 'setup@acme.test' } });
    assert.equal(res.statusCode, 429);
    assert.equal(res.body.code, 'too_many_code_requests');
    assert.equal(callsOf('retargetNcVerification').length, 1);
    assert.equal(callsOf('sendNcVerificationCodeEmail').length, 0);
});

test('retarget: within budget mails the code to the new admin', async () => {
    resetFx();
    fx.pendingRow = { orgId: 'org-v', hasVerification: true, status: 'pending', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    fx.sendResult = { status: 'ok', row: SENT_ROW };
    const res = await dispatch({ url: '/connector/bootstrap/pending/p1/retarget', body: { email: 'setup@acme.test' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.expiresAt, SENT_ROW.expiresAt);
    assert.equal(callsOf('sendNcVerificationCodeEmail')[0][1].to, 'setup@acme.test');
});
