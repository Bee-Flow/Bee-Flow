/**
 * routes/automation/sharing.js — GET/PUT /:id/shares and POST
 * /:id/transfer-owner, over a real Express app with every dependency
 * injected through makeSharingRouter (no module mocking).
 *
 * Proven:
 *   - GET: view and up read the list (names, member counts, runsAs = owner);
 *     run-only and strangers get 403;
 *   - PUT: owner or org admin only (an editor gets 403); every principal is
 *     checked against the automation's organisation; duplicates and the owner
 *     are refused by name;
 *   - licence: adding or widening a share goes through the automation_sharing
 *     gate (403 feature_locked without it); removing or lowering one does not;
 *   - transfer: owner only; the target must already be an editor or an org
 *     admin; the answer names the new owner, runs follow them, and an active
 *     app-event automation is re-subscribed under the new owner.
 *
 * Run: cd server && node --test routes/automation/sharing.test.js
 */

'use strict';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { makeSharingRouter } = require('./sharing');
const { serve } = require('../../core/http/routeHarness');

const USERS = {
    owner: { id: 'owner', displayName: 'Olga', organizationId: 'org1', groups: [] },
    ed: { id: 'ed', username: 'ed', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', displayName: 'Vic', organizationId: 'org1', groups: ['g-fin'] },
    ron: { id: 'ron', displayName: 'Ron', organizationId: 'org1', groups: [] },
    adm: { id: 'adm', displayName: 'Ada', organizationId: 'org1', groups: [] },
    newbie: { id: 'newbie', displayName: 'New', organizationId: 'org1', groups: [] },
    outsider: { id: 'outsider', displayName: 'Out', organizationId: 'org2', groups: [] },
};
const GROUPS = { 'g-fin': { id: 'g-fin', name: 'Finance', organizationId: 'org1' } };

let automations;
let shares;
let calls;
let licensed;

function fakeStore() {
    return {
        async getAutomation(id) { return automations[id] ? { ...automations[id] } : null; },
        async listSharesForAutomation(id) { return (shares[id] || []).map(s => ({ ...s })); },
        async replaceSharesForAutomation(id, list, by) {
            calls.replace.push({ id, list, by });
            shares[id] = list.map(s => ({ ...s }));
            return shares[id];
        },
        async countGroupMembers(orgId, ids) { return new Map(ids.filter(i => GROUPS[i]).map(i => [i, 7])); },
        async transferAutomationOwner(id, { fromUserId, toUserId }) {
            const a = automations[id];
            if (!a || a.userId !== fromUserId) return null;
            a.userId = toUserId;
            shares[id] = [...(shares[id] || []).filter(s => !(s.principalType === 'user' && s.principalId === toUserId)),
                { principalType: 'user', principalId: fromUserId, role: 'edit' }];
            return { ...a };
        },
        async deleteSubscriptionsForAutomation(id) { calls.subs.push(['delete', id]); },
    };
}

let api;

before(() => {
    api = serve('/', makeSharingRouter({
        store: fakeStore(),
        getUser: async (id) => USERS[id] || null,
        getGroup: async (id) => GROUPS[id] || null,
        hasPermission: async (id, perm) => perm === 'manage_automations' && id === 'adm',
        validateGroups: async (orgId, ids) => {
            const bad = ids.filter(i => !GROUPS[i] || GROUPS[i].organizationId !== orgId);
            if (bad.length) throw Object.assign(new Error('Invalid groups'), { status: 400 });
            return ids;
        },
        sharingGate: (req, res, next) => {
            calls.gate++;
            if (licensed) return next();
            return res.status(403).json({ error: 'feature_locked', feature: 'automation_sharing', required: 'enterprise' });
        },
        sharingAvailable: async () => licensed,
        listMembers: async (orgId) => Object.values(USERS).filter(u => u.organizationId === orgId),
        listGroups: async () => [...Object.values(GROUPS), { id: 'g-other', name: 'Other org', organizationId: 'org2' }],
        subscriptions: {
            hasAppEventTrigger: (def) => def?.trigger?.kind === 'app_event',
            revokeRemoteSubscriptions: async (id, userId) => { calls.subs.push(['revoke', id, userId]); },
            syncAppEventSubscription: async (id, userId) => { calls.subs.push(['sync', id, userId]); },
        },
    }));
});

after(() => api.close());

beforeEach(() => {
    automations = {
        a1: { id: 'a1', userId: 'owner', organizationId: 'org1', isActive: false, liveVersion: null, definition: { trigger: { kind: 'manual' } } },
        a2: {
            id: 'a2', userId: 'owner', organizationId: 'org1', isActive: true, liveVersion: 2,
            definition: { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } },
            liveDefinition: { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } } },
        },
    };
    shares = {
        a1: [
            { principalType: 'user', principalId: 'ed', role: 'edit' },
            { principalType: 'group', principalId: 'g-fin', role: 'view' },
            { principalType: 'user', principalId: 'ron', role: 'run' },
        ],
        a2: [{ principalType: 'user', principalId: 'ed', role: 'edit' }],
    };
    calls = { replace: [], gate: 0, subs: [] };
    licensed = true;
});

const call = (method, path, { as = 'owner', body } = {}) => api.call(method, path, { body, user: { id: as, organizationId: 'org1' } });

test('GET /:id/shares: the owner, the list with names and counts, who steps run as', async () => {
    const res = await call('GET', '/a1/shares');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.owner, { userId: 'owner', name: 'Olga' });
    assert.deepStrictEqual(res.body.runsAs, { userId: 'owner', name: 'Olga' });
    assert.deepStrictEqual(res.body.shares, [
        { principalType: 'user', principalId: 'ed', role: 'edit', name: 'ed' },
        { principalType: 'group', principalId: 'g-fin', role: 'view', name: 'Finance', memberCount: 7 },
        { principalType: 'user', principalId: 'ron', role: 'run', name: 'Ron' },
    ]);
    assert.strictEqual(res.body.myRole, 'owner');
    assert.strictEqual(res.body.canManage, true);
    assert.strictEqual(res.body.sharingAvailable, true);
});

test('GET /:id/shares: view and edit read it without managing it; run-only and strangers are refused', async () => {
    const viewer = await call('GET', '/a1/shares', { as: 'vic' });
    assert.strictEqual(viewer.status, 200);
    assert.strictEqual(viewer.body.myRole, 'view');
    assert.strictEqual(viewer.body.canManage, false);
    assert.strictEqual((await call('GET', '/a1/shares', { as: 'ed' })).body.canManage, false);
    const runner = await call('GET', '/a1/shares', { as: 'ron' });
    assert.strictEqual(runner.status, 403);
    assert.deepStrictEqual(runner.body, { error: 'Forbidden', code: 'automation_forbidden', need: 'view' });
    assert.strictEqual((await call('GET', '/a1/shares', { as: 'newbie' })).status, 403);
    assert.strictEqual((await call('GET', '/nope/shares')).status, 404);
});

test('PUT /:id/shares: owner and org admin may; an editor may not', async () => {
    const list = [{ principalType: 'user', principalId: 'ed', role: 'view' }];
    const byEditor = await call('PUT', '/a1/shares', { as: 'ed', body: { shares: list } });
    assert.strictEqual(byEditor.status, 403);
    assert.strictEqual(calls.replace.length, 0);
    const byAdmin = await call('PUT', '/a1/shares', { as: 'adm', body: { shares: list } });
    assert.strictEqual(byAdmin.status, 200);
    assert.strictEqual(byAdmin.body.canManage, true);
    assert.deepStrictEqual(calls.replace[0].list, list);
    assert.strictEqual(calls.replace[0].by, 'adm');
});

test('PUT /:id/shares: principals are checked against the organisation, and refused by name', async () => {
    const cases = [
        [[{ principalType: 'user', principalId: 'outsider', role: 'run' }], 'share_user_unknown'],
        [[{ principalType: 'user', principalId: 'ghost', role: 'run' }], 'share_user_unknown'],
        [[{ principalType: 'group', principalId: 'g-elsewhere', role: 'run' }], 'share_group_unknown'],
        [[{ principalType: 'user', principalId: 'owner', role: 'edit' }], 'share_with_owner'],
        [[{ principalType: 'user', principalId: 'ed', role: 'run' }, { principalType: 'user', principalId: 'ed', role: 'edit' }], 'duplicate_share'],
    ];
    for (const [list, code] of cases) {
        const res = await call('PUT', '/a1/shares', { body: { shares: list } });
        assert.strictEqual(res.status, 400, code);
        assert.strictEqual(res.body.code, code);
    }
    const badRole = await call('PUT', '/a1/shares', { body: { shares: [{ principalType: 'user', principalId: 'ed', role: 'admin' }] } });
    assert.strictEqual(badRole.status, 400);
    assert.strictEqual(badRole.body.code, 'invalid_request');
    assert.strictEqual(calls.replace.length, 0);
});

test('licence: adding or widening goes through the automation_sharing gate', async () => {
    licensed = false;
    const add = await call('PUT', '/a1/shares', { body: { shares: [...shares.a1, { principalType: 'user', principalId: 'newbie', role: 'run' }] } });
    assert.strictEqual(add.status, 403);
    assert.strictEqual(add.body.error, 'feature_locked');
    const widen = await call('PUT', '/a1/shares', { body: { shares: shares.a1.map(s => (s.principalId === 'ron' ? { ...s, role: 'edit' } : s)) } });
    assert.strictEqual(widen.status, 403);
    assert.strictEqual(calls.gate, 2);
    assert.strictEqual(calls.replace.length, 0);
});

test('licence: removing or lowering a share is never gated', async () => {
    licensed = false;
    const lower = await call('PUT', '/a1/shares', { body: { shares: [
        { principalType: 'user', principalId: 'ed', role: 'view' },
        { principalType: 'group', principalId: 'g-fin', role: 'view' },
    ] } });
    assert.strictEqual(lower.status, 200, JSON.stringify(lower.body));
    assert.strictEqual(lower.body.sharingAvailable, false);
    const clear = await call('PUT', '/a1/shares', { body: { shares: [] } });
    assert.strictEqual(clear.status, 200);
    assert.deepStrictEqual(clear.body.shares, []);
    assert.strictEqual(calls.gate, 0);
});

test('transfer: owner only, to an editor or an org admin', async () => {
    assert.strictEqual((await call('POST', '/a1/transfer-owner', { as: 'ed', body: { userId: 'ed' } })).status, 403);
    const notEditor = await call('POST', '/a1/transfer-owner', { body: { userId: 'vic' } });
    assert.strictEqual(notEditor.status, 400);
    assert.strictEqual(notEditor.body.code, 'transfer_target_not_editor');
    const outsider = await call('POST', '/a1/transfer-owner', { body: { userId: 'outsider' } });
    assert.strictEqual(outsider.body.code, 'transfer_target_unknown');
    const self = await call('POST', '/a1/transfer-owner', { body: { userId: 'owner' } });
    assert.strictEqual(self.body.code, 'already_owner');

    const ok = await call('POST', '/a1/transfer-owner', { body: { userId: 'ed' } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.deepStrictEqual(ok.body.owner, { userId: 'ed', name: 'ed' });
    assert.deepStrictEqual(ok.body.runsAs, ok.body.owner);
    assert.strictEqual(ok.body.automation.userId, 'ed');
    assert.strictEqual(ok.body.automation.myRole, 'edit', 'the old owner keeps edit');
    assert.deepStrictEqual(ok.body.warnings, []);
    assert.deepStrictEqual(calls.subs, [], 'a paused automation has nothing to re-subscribe');

    const toAdmin = await call('POST', '/a1/transfer-owner', { as: 'ed', body: { userId: 'adm' } });
    assert.strictEqual(toAdmin.status, 200);
    assert.strictEqual(toAdmin.body.owner.userId, 'adm');
});

test('transfer of an active app-event automation re-subscribes it under the new owner', async () => {
    const res = await call('POST', '/a2/transfer-owner', { body: { userId: 'ed' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(calls.subs, [['revoke', 'a2', 'owner'], ['delete', 'a2'], ['sync', 'a2', 'ed']]);
});

test('GET /:id/principals: the automation organisation\'s people and groups, names only, for anyone who may view', async () => {
    const res = await call('GET', '/a1/principals', { as: 'vic' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.groups, [{ id: 'g-fin', name: 'Finance', memberCount: 7 }]);
    const ids = res.body.users.map(u => u.id).sort();
    assert.deepStrictEqual(ids, ['adm', 'ed', 'newbie', 'owner', 'ron', 'vic']);
    assert.deepStrictEqual(res.body.users.find(u => u.id === 'owner'), { id: 'owner', name: 'Olga' });
    assert.ok(res.body.users.every(u => Object.keys(u).join() === 'id,name'), 'no e-mail or other fields');

    const runOnly = await call('GET', '/a1/principals', { as: 'ron' });
    assert.strictEqual(runOnly.status, 403);
    const stranger = await call('GET', '/a1/principals', { as: 'outsider' });
    assert.strictEqual(stranger.status, 403);
});
