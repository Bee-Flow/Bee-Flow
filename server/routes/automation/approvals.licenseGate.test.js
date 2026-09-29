'use strict';

/**
 * The Approvals licence gate — and, just as load-bearing, the DRAIN EXEMPTION.
 *
 * Approvals is an Enterprise feature (`approvals` in license/tiers.js), but the
 * gate is deliberately asymmetric:
 *
 *   GATED    browsing — GET /approvals, /approvals/facets, /approvals/directory
 *   UNGATED  finishing — GET /approvals/:id, POST /approvals/:id/decide,
 *            POST /approvals/:id/withdraw, GET /approvals/:id/files/:fileId
 *
 * A pending approval holds a paused run hostage. If deciding needed the
 * licence, a lapse or a plan downgrade would freeze that run permanently with
 * no in-product way out — the customer's own work, locked behind a paywall
 * they already fell off. So work already in flight can always be drained; only
 * browsing (and, upstream of this router, creating) is paid.
 *
 * Two things are proven here that no other test covers:
 *   1. WHICH routes carry the gate (and that it is per-route middleware, not a
 *      router.use — that would shadow the first-match order pinned by
 *      routes/automation.routetable.test.js).
 *   2. That an unlicensed caller can still read, decide and withdraw a pending
 *      approval end-to-end.
 *
 * Harness: the formPublic.test.js family — every dependency mocked, handlers
 * driven directly, no DB / network / timers.
 *
 * Run: cd server && node --test --test-force-exit routes/automation/approvals.licenseGate.test.js
 */

const { test, beforeEach } = require('node:test');
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

const OWNER = 'u_owner';
const APPROVAL = {
    id: 'ap_1',
    status: 'pending',
    ownerId: OWNER,
    organizationId: 'org1',
    automationId: 'auto1',
    runId: 'run1',
    stepId: 'step1',
    attachments: [],
};

// Survives resetState(): the gate factory runs once, at module load, long
// before the first beforeEach.
const factoryCalls = [];

let state;
function resetState() {
    state = {
        // The capability ids the (mocked) resolver says this session holds.
        // Empty = a community / lapsed org, which is the interesting case.
        granted: new Set(),
        gateChecks: [],
        decided: [],
        withdrawn: [],
        approval: { ...APPROVAL },
    };
}
resetState();

// ── the licence resolver ────────────────────────────────────────────────
// Stands in for core/entitlements/entitlements. The real one needs the
// capability registry + a tier resolution (i.e. a DB); its deny body is
// asserted against the real middleware in license/communityEnforcement.test.js,
// so what matters HERE is purely which routes consult it.
mock(path.join(SERVER, 'core/entitlements/entitlements'), {
    requireCapability: (capId) => {
        factoryCalls.push(capId);
        return function fakeCapabilityGate(req, res, next) {
            state.gateChecks.push(capId);
            if (state.granted.has(capId)) return next();
            return res.status(403).json({
                error: 'feature_locked', feature: capId, required: 'enterprise', current: 'community',
                upgrade_url: 'https://beeflow.nl/pricing',
            });
        };
    },
});

mock(path.join(SERVER, 'auth/permissions'), {
    isOrgAdminRole: (role) => ['org_admin', 'admin'].includes(role),
});
mock(path.join(SERVER, 'auth/orgMembership'), { parseGroupIds: () => [] });
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => ({ id, organizationId: 'org1', orgRole: 'member' }),
    getOrgMembersForDirectory: async () => [{ id: OWNER, displayName: 'Owner' }],
    getAllGroups: async () => [],
});
mock(path.join(SERVER, 'stores/automationStore'), {
    listApprovals: async () => ({ approvals: [], nextCursor: null }),
    getApprovalFacets: async () => ({ status: { pending: 1 } }),
    getApproval: async (id) => (id === state.approval.id ? state.approval : null),
    getApprovalAudit: async () => [],
    getApprovalVotes: async () => [],
    getRun: async () => ({ id: 'run1', status: 'awaiting_approval' }),
    listRunsForUser: async () => ({ runs: [] }),
    getApprovalForRunStep: async () => null,
    getAutomation: async () => null,
    getRunsInChain: async () => [],
    getGeneratedFileForRuns: async () => null,
});
mock(path.join(SERVER, 'automation/approvalService'), {
    ensureApprovalForRun: async () => null,
    canView: () => true,
    canDecide: () => true,
    hasStages: () => false,
    hasPanel: () => false,
    decide: async ({ decision }) => {
        state.decided.push(decision);
        return { code: 200, body: { ok: true, status: 'approved' } };
    },
    withdraw: async () => {
        state.withdrawn.push(true);
        return { code: 200, body: { ok: true, status: 'withdrawn' } };
    },
});

const router = require('./approvals');

// ── tiny express-router driver ──────────────────────────────────────────
function makeRes() {
    return {
        statusCode: null,
        body: null,
        headers: {},
        status(c) { this.statusCode = c; return this; },
        json(b) { this.body = b; return this; },
        set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
        setHeader(k, v) { return this.set(k, v); },
    };
}
function makeReq({ params = {}, query = {}, body = {}, userId = OWNER } = {}) {
    return {
        params, query, body,
        session: { isAuthenticated: true, user: { id: userId, organizationId: 'org1' } },
    };
}
function layerFor(method, routePath) {
    const layer = router.stack.find(l => l.route && l.route.path === routePath && l.route.methods[method]);
    if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
    return layer;
}
const chainNames = (method, routePath) => layerFor(method, routePath).route.stack.map(s => s.handle.name);
const isGated = (method, routePath) => chainNames(method, routePath).includes('fakeCapabilityGate');

/** Run a route's whole middleware chain, in order, exactly as express would. */
async function call(method, routePath, req) {
    const handlers = layerFor(method, routePath).route.stack.map(s => s.handle);
    const res = makeRes();
    let i = 0;
    const next = async () => {
        const h = handlers[i++];
        if (h) await h(req, res, next);
    };
    await next();
    return res;
}

const GATED = [
    ['get', '/approvals'],
    ['get', '/approvals/facets'],
    ['get', '/approvals/directory'],
];
const DRAIN = [
    ['get', '/approvals/:id'],
    ['post', '/approvals/:id/decide'],
    ['post', '/approvals/:id/withdraw'],
    ['get', '/approvals/:id/files/:fileId'],
];

beforeEach(resetState);

test('one gate, built once at module load, for the `approvals` capability', () => {
    // One shared middleware instance rather than requireCapability(...) per
    // route: the capability id is resolved (and would throw on a typo) exactly
    // once, at boot, not on the first request to each route.
    assert.deepStrictEqual(factoryCalls, ['approvals']);
    for (const [m, p] of GATED) {
        assert.ok(isGated(m, p), `${m.toUpperCase()} ${p} must carry the licence gate`);
    }
});

test('the gate is PER-ROUTE middleware, never a router.use', () => {
    // A router.use here would sit either above the /approvals literals (gating
    // half of the Community /api/automation API) or below them (gating
    // nothing), and would reorder the first-match table that
    // routes/automation.routetable.test.js freezes.
    const bare = router.stack.filter(l => !l.route).map(l => l.handle?.name || 'anonymous');
    assert.deepStrictEqual(bare, [], `approvals.js must not register router-level middleware: ${bare.join(', ')}`);
});

test('browsing is gated: list, facets and the approver directory', async () => {
    for (const [m, p] of GATED) {
        const res = await call(m, p, makeReq({ params: {} }));
        assert.strictEqual(res.statusCode, 403, `${m.toUpperCase()} ${p} must 403 without the capability`);
        assert.strictEqual(res.body?.error, 'feature_locked');
        assert.strictEqual(res.body?.feature, 'approvals');
    }
});

test('browsing works once the capability is held', async () => {
    state.granted.add('approvals');
    const list = await call('get', '/approvals', makeReq());
    assert.strictEqual(list.statusCode, null, 'a licensed list must not write an error status');
    assert.deepStrictEqual(list.body, { approvals: [], nextCursor: null, scope: 'mine' });

    const facets = await call('get', '/approvals/facets', makeReq());
    assert.strictEqual(facets.body?.facets?.status?.pending, 1);

    const dir = await call('get', '/approvals/directory', makeReq());
    assert.strictEqual(dir.body?.members?.length, 1);
});

test('DRAIN EXEMPTION: the finishing routes carry no gate at all', () => {
    for (const [m, p] of DRAIN) {
        assert.ok(!isGated(m, p),
            `${m.toUpperCase()} ${p} must stay UNGATED — gating it strands a pending approval, and its paused run, on a lapse`);
    }
});

test('DRAIN EXEMPTION: a pending approval can still be read without the capability', async () => {
    const res = await call('get', '/approvals/:id', makeReq({ params: { id: 'ap_1' } }));
    assert.strictEqual(res.statusCode, null);
    assert.strictEqual(res.body?.approval?.id, 'ap_1');
    assert.strictEqual(res.body?.canDecide, true);
    assert.strictEqual(res.body?.canWithdraw, true);
    assert.deepStrictEqual(state.gateChecks, []);
});

test('DRAIN EXEMPTION: a pending approval can still be DECIDED without the capability', async () => {
    const res = await call('post', '/approvals/:id/decide',
        makeReq({ params: { id: 'ap_1' }, body: { decision: 'approve' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, status: 'approved' });
    assert.deepStrictEqual(state.decided, ['approve']);
    assert.deepStrictEqual(state.gateChecks, [], 'deciding must never consult the licence resolver');
});

test('DRAIN EXEMPTION: a pending approval can still be WITHDRAWN without the capability', async () => {
    const res = await call('post', '/approvals/:id/withdraw',
        makeReq({ params: { id: 'ap_1' }, body: { reason: 'never mind' } }));
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true, status: 'withdrawn' });
    assert.deepStrictEqual(state.withdrawn, [true]);
    assert.deepStrictEqual(state.gateChecks, []);
});

test('the drain does not become a bypass: the normal auth checks still run', async () => {
    // Withdraw is owner/org-admin only. An assignee without the licence gets
    // the SAME 403 they would get with it — the exemption widens nobody's
    // rights, it only removes the licence axis.
    const res = await call('post', '/approvals/:id/withdraw',
        makeReq({ params: { id: 'ap_1' }, userId: 'u_assignee' }));
    assert.strictEqual(res.statusCode, 403);
    assert.match(res.body?.error || '', /owner or an org admin/i);
    assert.deepStrictEqual(state.withdrawn, []);
});
