'use strict';

/**
 * The project compliance hint API — factory router with injected fakes behind
 * a real express app (core/http/routeHarness serve()).
 *
 * Pinned: 401 without a session, 404 for a non-member, a viewer gets
 * `{hint:null}` and 403 on writes; one allow-listed hint for an owner, the
 * files hint for an editor; nothing when the module is absent, the org switched
 * hints off, or anything fails on the way; dismiss holds until the count
 * changes, snooze for 7 or 30 days; closed params and bodies.
 *
 * Run: cd server && node --test routes/projects/complianceHints.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { serve, assertRefused } = require('../../core/http/routeHarness');
const { makeComplianceHintsRouter } = require('./complianceHints');

const NOW = Date.parse('2026-09-29T12:00:00Z');
const OWNER = { id: 'u_owner', organizationId: 'org1' };
const EDITOR = { id: 'u_editor', organizationId: 'org1' };
const VIEWER = { id: 'u_viewer', organizationId: 'org1' };
const STRANGER = { id: 'u_stranger', organizationId: 'org1' };
const ROLES = { p1: { u_owner: 'owner', u_editor: 'editor', u_viewer: 'viewer' } };
const ORDER = { viewer: 0, editor: 1, owner: 2 };

const state = { rows: [], settings: {}, dismissals: new Map(), moduleOn: true, broken: false, orgAsked: [] };
const store = {
    getSettings: async (orgId) => { state.orgAsked.push(orgId); return state.settings; },
    getLatestForChecks: async () => { if (state.broken) throw new Error('db down'); return state.rows; },
    listFindingStates: async () => [],
    getHintDismissals: async (userId, projectId) => Object.fromEntries(
        [...state.dismissals.entries()].filter(([k]) => k.startsWith(`${userId}|${projectId}|`)).map(([k, v]) => [k.split('|')[2], v])),
    recordHintDismissal: async (userId, projectId, key, { fingerprint, snoozedUntil }) => {
        state.dismissals.set(`${userId}|${projectId}|${key}`, { fingerprint, snoozedUntil, dismissedAt: snoozedUntil ? null : new Date(NOW).toISOString() });
    },
};

const router = makeComplianceHintsRouter({
    requireProjectRole: (min) => (req, res, next) => {
        const uid = req.session?.user?.id;
        if (!uid) return res.status(401).json({ error: 'Not authenticated' });
        const role = ROLES[req.params.id]?.[uid];
        if (!role) return res.status(404).json({ error: 'Not found' });
        if (ORDER[role] < ORDER[min]) return res.status(403).json({ error: 'Insufficient permissions' });
        req.projectRole = role;
        next();
    },
    getProject: async (id) => (id === 'p1' ? { id: 'p1', organizationId: '' } : null),
    complianceStore: store,
    activeRegulations: async () => new Set(['GDPR', 'ISO27001']),
    moduleAvailable: () => state.moduleOn,
    checkDef: () => null,
    now: () => NOW,
    log: { warn: () => {} },
});
const api = serve('/api/projects', router);
after(api.close);

const ROWS = () => [
    { check_id: 'GDPR-Art32-project-access', scope_id: null, status: 'fail', evidence: { offenders: [{ project_id: 'p1', foreign: 1, dangling: 0 }] } },
    { check_id: 'GDPR-Art32-project-files-unscanned', scope_id: null, status: 'warn', evidence: { offenders: [{ project_id: 'p1', unscanned: 3 }] } },
];

beforeEach(() => {
    state.rows = ROWS();
    state.settings = {};
    state.dismissals.clear();
    state.moduleOn = true;
    state.broken = false;
    state.orgAsked.length = 0;
});

const get = (user) => api.call('GET', '/api/projects/p1/compliance-hints', { user });

test('the owner gets one hint — the most important — in the contract shape', async () => {
    const res = await get(OWNER);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { hint: {
        key: 'project_foreign_members', severity: 'high', titleKey: 'compliance.project_hint.project_foreign_members',
        params: { count: 1 }, action: { kind: 'navigate', target: '/app/projects/p1/members' },
    } });
    assert.deepStrictEqual(state.orgAsked, ['default'], 'an org-less project reads the default bucket');
});

test('an editor gets the files hint; a viewer gets nothing; a stranger 404; no session 401', async () => {
    assert.strictEqual((await get(EDITOR)).body.hint.key, 'project_files_unscanned');
    assert.deepStrictEqual((await get(VIEWER)).body, { hint: null });
    assert.strictEqual((await get(STRANGER)).status, 404);
    assert.strictEqual((await get(null)).status, 401);
});

test('no module, hints switched off, stale or failing reads: no hint, never an error', async () => {
    state.moduleOn = false;
    assert.deepStrictEqual((await get(OWNER)).body, { hint: null });
    state.moduleOn = true;
    state.settings = { project_owner_hints_enabled: false };
    assert.deepStrictEqual((await get(OWNER)).body, { hint: null });
    state.settings = {};
    state.broken = true;
    const res = await get(OWNER);
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { hint: null });
    state.broken = false;
    state.rows = [];
    assert.deepStrictEqual((await get(OWNER)).body, { hint: null }, 'never run: nothing, and no "all good"');
});

test('dismiss puts a hint away until what it reports changes, then the next one shows', async () => {
    const d = await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/dismiss', { user: EDITOR, body: {} });
    assert.strictEqual(d.status, 200);
    assert.deepStrictEqual((await get(EDITOR)).body, { hint: null });
    state.rows[1].evidence.offenders[0].unscanned = 4;
    assert.strictEqual((await get(EDITOR)).body.hint.params.count, 4, 'one more file brings it back');
    await api.call('POST', '/api/projects/p1/compliance-hints/project_foreign_members/dismiss', { user: OWNER, body: {} });
    assert.strictEqual((await get(OWNER)).body.hint.key, 'project_files_unscanned', 'per person, and the next hint in line');
});

test('snooze holds 7 or 30 days', async () => {
    const s = await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/snooze', { user: EDITOR, body: { days: 30 } });
    assert.strictEqual(s.status, 200);
    const stored = state.dismissals.get('u_editor|p1|project_files_unscanned');
    assert.strictEqual(stored.snoozedUntil, new Date(NOW + 30 * 86400_000).toISOString());
    assert.deepStrictEqual((await get(EDITOR)).body, { hint: null });
    await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/snooze', { user: OWNER, body: {} });
    assert.strictEqual(state.dismissals.get('u_owner|p1|project_files_unscanned').snoozedUntil, new Date(NOW + 7 * 86400_000).toISOString());
});

test('writes need an editor; keys and bodies are closed', async () => {
    assert.strictEqual((await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/dismiss', { user: VIEWER, body: {} })).status, 403);
    assert.strictEqual(state.dismissals.size, 0);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/compliance-hints/project_personal_data/dismiss', { user: OWNER, body: {} }), 'params.key', /key must be one of/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/snooze', { user: OWNER, body: { days: 90 } }), 'body.days', /7 or 30/);
    assertRefused(assert, await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/dismiss', { user: OWNER, body: { forever: true } }));
});

test('dismissing a hint that is not showing stores nothing and answers the same', async () => {
    state.rows = [];
    const res = await api.call('POST', '/api/projects/p1/compliance-hints/project_files_unscanned/dismiss', { user: OWNER, body: {} });
    assert.deepStrictEqual(res.body, { ok: true });
    assert.strictEqual(state.dismissals.size, 0);
});
