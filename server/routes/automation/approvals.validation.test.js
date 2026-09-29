'use strict';

/**
 * What the approval routes accept, and what they say when they refuse
 * (routes/automation/approvals.js).
 *
 * The file header promises that an org admin whose toggle stopped working
 * HEARS about it rather than quietly seeing less. `scope` did not keep that
 * promise: `=== 'org' ? 'org' : 'mine'` turned `scope=Org` into the caller's
 * own approvals, answered 200, and said `scope: 'mine'` in a field nobody
 * reads. `status` failed the other way round — the store drops the values it
 * does not recognise, and an empty list leaves no status condition at all, so
 * `?status=aproved` answered with EVERY approval the viewer may see.
 *
 * What this file pins is the part a caller can act on:
 *
 *   - the 400 NAMES the field (`query.status`), not just "invalid request";
 *   - the message is a sentence, and lists the values;
 *   - the store and the decision service are never reached, so a refused
 *     request changes nothing.
 *
 * Run: cd server && node --test routes/automation/approvals.validation.test.js
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

// Every store and service call lands in `touched`. A refused request must
// leave it empty.
const touched = [];
const APPROVAL = { id: 'ap1', ownerId: 'u1', organizationId: 'org1', status: 'pending', runId: null };

mock(path.join(SERVER, 'stores/automationStore'), {
    listApprovals: async (p) => { touched.push({ what: 'listApprovals', args: [p] }); return { approvals: [], nextCursor: null }; },
    getApprovalFacets: async (p) => { touched.push({ what: 'getApprovalFacets', args: [p] }); return { status: {} }; },
    getApproval: async (id) => { touched.push({ what: 'getApproval', args: [id] }); return { ...APPROVAL, id }; },
    getRun: async () => null,
    listRunsForUser: async () => ({ runs: [] }),
    getApprovalForRunStep: async () => null,
    getAutomation: async () => null,
});
mock(path.join(SERVER, 'automation/approvalService'), {
    canView: () => true,
    canDecide: () => true,
    ensureApprovalForRun: async () => null,
    decide: async (p) => { touched.push({ what: 'decide', args: [p] }); return { code: 200, body: { ok: true } }; },
    withdraw: async (p) => { touched.push({ what: 'withdraw', args: [p] }); return { code: 200, body: { ok: true } }; },
});
mock(path.join(SERVER, 'auth/permissions'), { isOrgAdminRole: () => true });
mock(path.join(SERVER, 'core/entitlements/entitlements'), { requireCapability: () => (req, res, next) => next() });
mock(path.join(SERVER, 'modules'), { requireModule: () => (req, res, next) => next() });
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => ({ id, organizationId: 'org1', orgRole: 'org_admin', groups: [] }),
    getOrgMembersForDirectory: async () => [],
    getAllGroups: async () => [],
});

const router = require('./approvals');
const { terminalErrorHandler } = require(path.join(SERVER, 'core/http/terminalErrorHandler'));

function dispatch({ method, url, body }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1', organizationId: 'org1', orgRole: 'org_admin' }, isAdmin: true },
            get() { return undefined; }, setTimeout() {},
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

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, `${what} -> ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ GET /approvals ═════════════════════════════════════════════════

test('a misspelled status is refused, not dropped into every approval there is', async () => {
    const res = await refuses({ method: 'GET', url: '/approvals?status=aproved' }, 'query.status');
    assert.strictEqual(res.body.error, 'status is a comma-separated list of: pending, approved, rejected, expired, cancelled.');
});

test('a mis-cased scope is refused, not silently narrowed to "mine"', async () => {
    const res = await refuses({ method: 'GET', url: '/approvals?scope=Org' }, 'query.scope');
    assert.strictEqual(res.body.error, 'scope is "mine" or "org".');
});

test('a misspelled filter is refused, not dropped into a wider list', async () => {
    await refuses({ method: 'GET', url: '/approvals?apId=app1' }, 'query');
});

test('the filters the panel offers still narrow', async () => {
    const res = await dispatch({ method: 'GET', url: '/approvals?scope=org&status=approved,rejected&limit=10' });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'listApprovals').args[0];
    assert.deepStrictEqual(args.status, ['approved', 'rejected']);
    assert.strictEqual(args.limit, 10);
    assert.deepStrictEqual(args.org, { orgId: 'org1' });
});

test('no scope at all still means "mine", from the schema', async () => {
    const res = await dispatch({ method: 'GET', url: '/approvals' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.scope, 'mine');
});

// ═══ GET /approvals/facets ══════════════════════════════════════════

test('a facets query only takes the context keys, not the list filters', async () => {
    await refuses({ method: 'GET', url: '/approvals/facets?status=pending' }, 'query');
});

// ═══ POST /approvals/:id/decide ═════════════════════════════════════

test('a decision nobody implements is refused before the approval is read', async () => {
    // approvalService answered this with a 400 too — but only after reading
    // the row, the run and the decider's name.
    const res = await refuses({ method: 'POST', url: '/approvals/ap1/decide', body: { decision: 'aprove' } }, 'body.decision');
    assert.strictEqual(res.body.error, 'decision is "approve" or "reject".');
});

test('a decision left out entirely is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/approvals/ap1/decide', body: {} }, 'body.decision');
    assert.strictEqual(res.body.error, 'decision is "approve" or "reject".');
});

test('answers that are a list, not a map, are refused by name', async () => {
    await refuses({ method: 'POST', url: '/approvals/ap1/decide', body: { decision: 'approve', answers: ['yes'] } }, 'body.answers');
});

test('a decision a caller may make still reaches the service, still forgiving of case', async () => {
    const res = await dispatch({ method: 'POST', url: '/approvals/ap1/decide', body: { decision: ' Approve ', reason: 'fine' } });
    assert.strictEqual(res.statusCode, 200);
    const args = touched.find((t) => t.what === 'decide').args[0];
    assert.strictEqual(args.decision, 'approve');
    assert.strictEqual(args.reason, 'fine');
});

// ═══ POST /approvals/:id/withdraw ═══════════════════════════════════

test('a key the withdraw route does not read is refused rather than ignored', async () => {
    await refuses({ method: 'POST', url: '/approvals/ap1/withdraw', body: { decision: 'reject' } }, 'body');
});
