'use strict';

/**
 * POST /api/compliance/checks/:id/state — the admin decision about one open
 * finding. The router takes its dependencies injected; the store is a small
 * in-memory double with the real store's shapes.
 *
 * Pinned: the gate (401 without a session, 403 without admin_compliance, and
 * nothing read behind either), the refusals (unknown check 404, inactive
 * framework 409, no open finding 409, reason and date rules 400, closed body
 * schema 400), the happy paths (acknowledge, accept with reason, snooze by
 * days, re-open), the fingerprint computed server-side from the stored row,
 * and an evidence row per decision that carries a hash of the reason, never
 * the reason.
 *
 * Run: cd server && node --test routes/compliance/findingStates.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { serve, assertRefused } = require('../../core/http/routeHarness');
const { makeFindingStateRouter } = require('./findingStates');
const findingState = require('../../compliance/findingState');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const DEFS = {
    'GDPR-Art32-project-access': { id: 'GDPR-Art32-project-access', regulation: 'GDPR' },
    'NIS2-Art21(2)(j)-admin-mfa': { id: 'NIS2-Art21(2)(j)-admin-mfa', regulation: 'NIS2' },
};

const state = { slots: [], states: new Map(), evidence: [], reads: 0, invalidated: [] };
const store = {
    listLatestScopes: async (_org, checkId) => { state.reads++; return state.slots.filter(s => s.check_id === checkId); },
    setFindingState: async (orgId, row) => {
        const saved = { check_id: row.checkId, scope_key: row.scopeKey, fingerprint: row.fingerprint, state: row.state,
            reason: row.reason, until: row.until, actor_id: row.actorId, updated_at: new Date(NOW).toISOString() };
        state.states.set(`${orgId}|${row.checkId}|${row.scopeKey}`, saved);
        return saved;
    },
    clearFindingState: async (orgId, checkId, scopeKey) => state.states.delete(`${orgId}|${checkId}|${scopeKey}`),
    addEvidence: async (row) => { state.evidence.push(row); return { id: state.evidence.length }; },
};

let denied = false;
const router = makeFindingStateRouter({
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (denied ? res.status(403).json({ error: 'forbidden' }) : next()),
    complianceStore: store,
    registry: { get: (id) => DEFS[id] || null },
    frameworkPolicy: { activeRegulations: async () => new Set(['GDPR']) },
    resolveOrgId: async () => 'org1',
    invalidateCounts: (orgId) => state.invalidated.push(orgId),
    now: () => NOW,
});
const api = serve('/api/compliance', router);
after(api.close);

const ROW = { check_id: 'GDPR-Art32-project-access', scope_type: 'global', scope_id: null, status: 'warn', evidence: { offenders: [{ project_id: 'p1' }] } };
const url = (id = 'GDPR-Art32-project-access') => `/api/compliance/checks/${encodeURIComponent(id)}/state`;

beforeEach(() => {
    state.slots = [ROW];
    state.states.clear();
    state.evidence.length = 0;
    state.reads = 0;
    state.invalidated.length = 0;
    denied = false;
});

test('acknowledging an open finding stores the server-side fingerprint and chains an evidence row', async () => {
    const res = await api.call('POST', url(), { body: { state: 'acknowledged' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.finding_state.state, 'acknowledged');
    assert.strictEqual(res.body.finding_state.active, true);
    assert.ok(!('fingerprint' in res.body.finding_state), 'the fingerprint never leaves the server');
    const stored = state.states.get('org1|GDPR-Art32-project-access|global');
    assert.strictEqual(stored.fingerprint, findingState.fingerprintOf(ROW));
    assert.strictEqual(stored.actor_id, 'u1');
    assert.strictEqual(state.evidence.length, 1);
    assert.strictEqual(state.evidence[0].subject_type, 'finding-state');
    assert.strictEqual(state.evidence[0].payload.action, 'finding_state');
    assert.deepStrictEqual(state.invalidated, ['org1']);
});

test('accepting a risk needs a reason; the chain gets its hash, never the words', async () => {
    const refused = await api.call('POST', url(), { body: { state: 'accepted_risk' } });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /reason/);
    const res = await api.call('POST', url(), { body: { state: 'accepted_risk', reason: 'Legal hold for client Jansen', until: '2027-01-01T00:00:00Z' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.body.finding_state.until, '2027-01-01T00:00:00.000Z');
    const ev = JSON.stringify(state.evidence);
    assert.ok(!ev.includes('Jansen'), 'the reason text is not in the immutable chain');
    assert.match(state.evidence[0].payload.reason_sha256, /^[0-9a-f]{64}$/);
});

test('a snooze needs a future end within a year; days are counted from now', async () => {
    assert.strictEqual((await api.call('POST', url(), { body: { state: 'snoozed' } })).status, 400);
    assert.strictEqual((await api.call('POST', url(), { body: { state: 'snoozed', until: '2026-09-01T00:00:00Z' } })).status, 400);
    assert.strictEqual((await api.call('POST', url(), { body: { state: 'snoozed', until: '2029-01-01T00:00:00Z' } })).status, 400);
    assertRefused(assert, await api.call('POST', url(), { body: { state: 'snoozed', days: 400 } }), 'body.days', /at most 365/);
    const ok = await api.call('POST', url(), { body: { state: 'snoozed', days: 7 } });
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual(ok.body.finding_state.until, new Date(NOW + 7 * 86400_000).toISOString());
});

test('re-opening forgets the decision and records that it did', async () => {
    await api.call('POST', url(), { body: { state: 'acknowledged' } });
    const res = await api.call('POST', url(), { body: { state: 'open' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.finding_state, null);
    assert.strictEqual(state.states.size, 0);
    assert.deepStrictEqual(state.evidence.map(e => e.payload.action), ['finding_state', 'finding_reopened']);
});

test('a per-source slot is addressed by its scope id', async () => {
    state.slots = [{ ...ROW, scope_type: 'per-source', scope_id: 'project:p9', status: 'fail' }];
    const res = await api.call('POST', url(), { body: { state: 'acknowledged', scope_id: 'project:p9' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.ok(state.states.has('org1|GDPR-Art32-project-access|project:p9'));
    const wrongSlot = await api.call('POST', url(), { body: { state: 'acknowledged', scope_id: 'project:other' } });
    assert.strictEqual(wrongSlot.status, 409);
    assert.strictEqual(wrongSlot.body.code, 'finding_not_open');
});

test('nothing to decide: a passing or missing row is 409; an unknown check 404; an inactive framework 409', async () => {
    state.slots = [{ ...ROW, status: 'pass' }];
    const pass = await api.call('POST', url(), { body: { state: 'acknowledged' } });
    assert.strictEqual(pass.status, 409);
    assert.strictEqual(pass.body.code, 'finding_not_open');
    const unknown = await api.call('POST', url('NOPE-1'), { body: { state: 'acknowledged' } });
    assert.strictEqual(unknown.status, 404);
    const inactive = await api.call('POST', url('NIS2-Art21(2)(j)-admin-mfa'), { body: { state: 'acknowledged' } });
    assert.strictEqual(inactive.status, 409);
    assert.strictEqual(inactive.body.code, 'framework_disabled');
    assert.strictEqual(state.evidence.length, 0);
});

test('the body schema is closed and speaks in sentences', async () => {
    assertRefused(assert, await api.call('POST', url(), { body: { state: 'resolved' } }), 'body.state', /state must be one of/);
    assertRefused(assert, await api.call('POST', url(), { body: { state: 'acknowledged', fingerprint: 'forged' } }));
    assertRefused(assert, await api.call('POST', url(), { body: { state: 'acknowledged', reason: 'x'.repeat(501) } }), 'body.reason');
});

test('no session is 401, a low role is 403, and nothing is read behind either', async () => {
    const anon = await api.call('POST', url(), { body: { state: 'acknowledged' }, user: null });
    assert.strictEqual(anon.status, 401);
    denied = true;
    const low = await api.call('POST', url(), { body: { state: 'acknowledged' } });
    assert.strictEqual(low.status, 403);
    assert.strictEqual(state.reads, 0);
    assert.strictEqual(state.states.size, 0);
});
