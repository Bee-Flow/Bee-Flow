'use strict';

/**
 * Track H2 — the ORGANISATION-wide run log (GET /_runs/org, /_runs/org/facets).
 *
 * routes/automation/runs.js is user-scoped by contract ("no admin-wide
 * endpoint"), and it stays that way: the org-wide read Studio → Runs & log
 * offers lives on its own two routes with a permission check of its own. This
 * file is the guard on that check, and on the shape of what comes back.
 *
 * WHAT IS ASSERTED, and why each one is a real failure mode:
 *
 *   - No permission → 403, and NOT a quiet fall-back to the caller's own runs.
 *     A narrowing refusal shows a smaller, entirely plausible list and says
 *     nothing, so a demoted admin goes on reading a "complete" log that has
 *     become personal.
 *   - No organisation → 403. On a personal install orgId is null, and a scope
 *     built from a null org either matches nothing or matches every org-less
 *     row on a shared instance.
 *   - Permission and org come from the USER ROW and the permission resolver —
 *     never from req.session.user.orgRole / .organizationId, which a stale
 *     session still carries after a demotion or a move.
 *   - A store that throws is a 500, not an empty list. An empty list and a
 *     failed read must not be the same screen.
 *   - The facets route proves the same thing again rather than trusting that
 *     the list call must have been allowed.
 *   - The row projection is an ALLOW-LIST: triggerPayload (a colleague's whole
 *     form submission / inbound e-mail) must never travel.
 *
 * Route handlers are invoked directly — same harness as
 * runs.schedulePreview.test.js.
 *
 * Run: node --test --test-force-exit routes/automation/runs.orgScope.test.js
 */
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

// ── Mutable test doubles ──────────────────────────────────────────────────
const calls = { list: [], facets: [], hasPermission: [], getUser: [] };
let listResult = { runs: [], nextCursor: null };
let facetsResult = { status: {}, automations: [] };
let listThrows = null;
let userRow = { id: 'u1', organizationId: 'org-1' };
let permissionAnswer = true;
let getUserThrows = false;
let hasPermissionThrows = false;

mock(path.join(SERVER, 'stores/automationStore'), {
    getAutomation: async () => null,
    getRunSteps: async () => [],
    listRunsForUser: async () => ({ runs: [{ id: 'own-run' }], nextCursor: null }),
    listRunsForOrg: async (orgId, filters, opts) => {
        calls.list.push({ orgId, filters, opts });
        if (listThrows) throw listThrows;
        return listResult;
    },
    getRunFacetsForOrg: async (orgId, filters) => {
        calls.facets.push({ orgId, filters });
        if (listThrows) throw listThrows;
        return facetsResult;
    },
});
mock(path.join(SERVER, 'stores/userStore'), {
    getUser: async (id) => {
        calls.getUser.push(id);
        if (getUserThrows) throw new Error('users table unreachable');
        return userRow;
    },
});
mock(path.join(SERVER, 'auth/permissions'), {
    hasPermission: async (userId, permission, session) => {
        calls.hasPermission.push({ userId, permission, session });
        if (hasPermissionThrows) throw new Error('permission store unreachable');
        return permissionAnswer;
    },
});
mock(path.join(SERVER, 'automation/deliverableEvents'), {
    getDeliverableEvents: () => ({ nextcloud: new Set() }),
    isPushPending: () => false,
});
mock(path.join(SERVER, 'automation/triggerBus'), {
    loadSession: async () => null,
    fetchLatestGmailMatch: async () => null,
    fetchLatestNextcloudMatch: async () => null,
});
mock(path.join(SERVER, 'utils/perUserRateLimit'), {
    perUserRateLimit: () => (req, res, next) => next(),
});

const runsRouter = require('./runs');

function findRoute(router, method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) return layer.route;
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}

/**
 * A route's WHOLE stack, not only its handler: `validate` sits in front of
 * these now, and a schema refusal leaves as an error rather than as a
 * response — so the terminal handler has to be here too, or a 400 reads as a
 * crashed test.
 */
function runStack(handles) {
    return async (req, res) => {
        for (const handle of handles) {
            const step = await new Promise((resolve, reject) => {
                let settled = false;
                const done = (v) => { if (!settled) { settled = true; resolve(v); } };
                try {
                    Promise.resolve(handle(req, res, (err) => done({ passed: true, err })))
                        .then(() => done({ passed: false }), reject);
                } catch (e) { reject(e); }
            });
            if (!step.passed) return res;
            if (step.err) {
                require(path.join(SERVER, 'core/http/terminalErrorHandler')).terminalErrorHandler(step.err, req, res, () => {});
                return res;
            }
        }
        return res;
    };
}

const handlerFor = (method, routePath) => runStack(findRoute(runsRouter, method, routePath).stack.map(l => l.handle));
const orgList = handlerFor('get', '/_runs/org');
const orgFacets = handlerFor('get', '/_runs/org/facets');

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

async function call(handler, { query = {}, session = { user: { id: 'u1' } } } = {}) {
    const res = makeRes();
    await handler({ method: 'GET', url: '/_runs/org', path: '/_runs/org', query, session, params: {}, body: {}, headers: {} }, res);
    return res;
}

function reset() {
    calls.list.length = 0; calls.facets.length = 0;
    calls.hasPermission.length = 0; calls.getUser.length = 0;
    listResult = { runs: [], nextCursor: null };
    facetsResult = { status: {}, automations: [] };
    listThrows = null;
    userRow = { id: 'u1', organizationId: 'org-1' };
    permissionAnswer = true;
    getUserThrows = false;
    hasPermissionThrows = false;
}

// ── The permission check ──────────────────────────────────────────────────

test('GET /_runs/org refuses with 403 when the caller lacks manage_automations', async () => {
    reset();
    permissionAnswer = false;
    const res = await call(orgList);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /manage_automations/);
    // THE POINT: it did not quietly answer with the caller's own runs.
    assert.equal(calls.list.length, 0, 'no list query may run for a refused caller');
    assert.ok(!res.body.runs, 'a refusal carries no rows at all');
});

test('GET /_runs/org asks for manage_automations by name, for the SESSION user', async () => {
    reset();
    await call(orgList);
    assert.equal(calls.hasPermission.length, 1);
    assert.equal(calls.hasPermission[0].permission, 'manage_automations');
    assert.equal(calls.hasPermission[0].userId, 'u1');
});

test('the organisation comes from the USER ROW, not from the session', async () => {
    reset();
    userRow = { id: 'u1', organizationId: 'org-real' };
    // A session left over from before the move still claims the old org. If the
    // handler read it, this caller would keep reading their previous
    // organisation's runs until they signed out.
    const res = await call(orgList, { session: { user: { id: 'u1', organizationId: 'org-stale', orgRole: 'org_admin' } } });
    assert.equal(res.statusCode, 200);
    assert.equal(calls.list[0].orgId, 'org-real');
});

test('no organisation is a refusal, never a scope over "org IS NULL"', async () => {
    reset();
    userRow = { id: 'u1', organizationId: null };
    const res = await call(orgList);
    assert.equal(res.statusCode, 403);
    assert.match(res.body.error, /organisation/i);
    assert.equal(calls.list.length, 0);
});

test('an unreadable user row is no organisation — the probe fails CLOSED', async () => {
    reset();
    getUserThrows = true;
    const res = await call(orgList);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.list.length, 0);
});

test('an unreadable permission store is no permission — that probe fails closed too', async () => {
    reset();
    hasPermissionThrows = true;
    const res = await call(orgList);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.list.length, 0);
});

test('an unauthenticated request is a 401 and never reaches the store', async () => {
    reset();
    const res = await call(orgList, { session: {} });
    assert.equal(res.statusCode, 401);
    assert.equal(calls.list.length, 0);
    assert.equal(calls.hasPermission.length, 0);
});

// ── What the allowed caller gets ──────────────────────────────────────────

test('an allowed caller gets the org list, its cursor, and the scope it asked for', async () => {
    reset();
    listResult = { runs: [{ id: 'r1', mine: false }], nextCursor: 'cur-2' };
    const res = await call(orgList, { query: { cursor: 'cur-1', limit: '25', status: 'error,success', automationId: 'a1' } });
    assert.equal(res.statusCode, 200);
    // Handoff 5: rows are decorated for the Runs tab (automation/runListRows.js).
    // The org log never names who started a run.
    assert.equal(res.body.runs.length, 1);
    assert.equal(res.body.runs[0].id, 'r1');
    assert.equal(res.body.runs[0].mine, false);
    assert.equal(res.body.runs[0].startedBy, null);
    assert.ok(!('approvalId' in res.body.runs[0]), 'the org log carries no approvalId');
    assert.equal(res.body.nextCursor, 'cur-2');
    assert.equal(res.body.scope, 'org');
    const { orgId, filters, opts } = calls.list[0];
    assert.equal(orgId, 'org-1');
    // The filters NARROW the proven scope; they are forwarded verbatim and the
    // store ANDs them on (stores/automationStore.runsFilter.test.js).
    assert.deepEqual(filters.status, ['error', 'success']);
    assert.equal(filters.automationId, 'a1');
    assert.equal(filters.cursor, 'cur-1');
    // The viewer travels only so each row can be stamped `mine`.
    assert.equal(opts.viewerUserId, 'u1');
});

test('a store failure propagates — an empty list and a failed read are not the same answer', async () => {
    reset();
    listThrows = new Error('runs table unreachable');
    // The handler throws; Express hands that to the terminal error handler,
    // which answers 500 without the message. It never answers `runs: []`.
    await assert.rejects(call(orgList), /runs table unreachable/);
});

// ── The facets twin ───────────────────────────────────────────────────────

test('GET /_runs/org/facets proves the permission AGAIN, on its own', async () => {
    reset();
    permissionAnswer = false;
    const res = await call(orgFacets);
    assert.equal(res.statusCode, 403);
    // Facets describe the shape of the organisation's activity — which
    // automations exist, how often they run, what breaks. Deriving the right to
    // see that from "the list call must have been allowed" is how a second
    // endpoint ends up ungated.
    assert.equal(calls.facets.length, 0);
});

test('GET /_runs/org/facets clamps range to 1..720 hours, like its user-scoped twin', async () => {
    reset();
    await call(orgFacets, { query: { range: '99999' } });
    assert.equal(calls.facets[0].filters.sinceTs > new Date(Date.now() - 721 * 3600 * 1000).toISOString(), true);
    const res = await call(orgFacets, { query: { range: '99999' } });
    assert.equal(res.body.rangeHours, 720);
    reset();
    const res2 = await call(orgFacets, { query: { range: '0' } });
    assert.equal(res2.body.rangeHours, 24, 'a missing or zero range is the 24h default, never "all time"');
});

test('GET /_runs/org/facets refuses a caller with no organisation', async () => {
    reset();
    userRow = { id: 'u1', organizationId: null };
    const res = await call(orgFacets);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.facets.length, 0);
});

// ── The row projection ────────────────────────────────────────────────────

test('rowToOrgRunRow is an allow-list: a colleague\'s trigger payload never travels', () => {
    // Loaded directly (the store module itself is mocked above for the routes).
    const { rowToOrgRunRow } = require(path.join(SERVER, 'stores/automationStore/runs'));
    const row = {
        id: 'r1',
        automation_id: 'a1',
        user_id: 'someone-else',
        trigger_kind: 'form',
        // The whole point: a published form's submission lands here.
        trigger_payload: { name: 'Jan Jansen', email: 'jan@example.com', message: 'my case' },
        mode: 'live',
        status: 'success',
        started_at: '2026-09-07T10:00:00.000Z',
        finished_at: '2026-09-07T10:00:05.000Z',
        duration_ms: 5000,
        summary: 'Sent',
        automation_title: 'Intake',
        automation_kind: 'automation',
        awaiting_step_expires_at: '2026-09-08T10:00:00.000Z',
        cancel_requested: true,
        approval_token: 'secret-token',
    };
    const out = rowToOrgRunRow(row, 'u1');
    assert.equal('triggerPayload' in out, false, 'trigger payload must not be in an org row');
    assert.equal('userId' in out, false, 'the owner id is not what this list is about');
    assert.equal('awaitingStepExpiresAt' in out, false);
    assert.equal('cancelRequested' in out, false);
    assert.equal('approvalToken' in out, false);
    // …and the fields the table actually renders are all there.
    for (const k of ['id', 'automationId', 'automationTitle', 'status', 'startedAt', 'durationMs', 'triggerKind', 'mine']) {
        assert.ok(k in out, `missing ${k}`);
    }
    // Not mine → false. Checked for a real match, never "not false".
    assert.equal(out.mine, false);
    assert.equal(rowToOrgRunRow({ ...row, user_id: 'u1' }, 'u1').mine, true);
    // An unknown viewer is not an owner.
    assert.equal(rowToOrgRunRow({ ...row, user_id: 'u1' }, null).mine, false);
    assert.equal(rowToOrgRunRow({ ...row, user_id: null }, null).mine, false);
});
