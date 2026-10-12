/**
 * automation/access.js — the role matrix behind every automation route
 * (handoff 5, sharing and roles). All lookups are injected: no database, no
 * module mocking.
 *
 * Proven:
 *   - owner → owner without a single lookup;
 *   - a direct user share and a group share grant their role; the strongest
 *     of several wins;
 *   - an org admin with manage_automations gets owner-level access, but only
 *     in the automation's own organisation;
 *   - a share never crosses organisations; an org-less automation borrows its
 *     owner's organisation;
 *   - every lookup failure is "no role" (fail closed);
 *   - roleSatisfies: run < view < edit < owner, for every pair;
 *   - projectForViewer strips the owner's builder chat for anyone else and
 *     leaves a run-only caller the triggers alone;
 *   - mayReadRun: view reads every run, run only the runs it started;
 *   - guard answers 403 with the needed role and returns null.
 *
 * Run: cd server && node --test automation/access.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
    makeAutomationAccess, roleSatisfies, strongestRole, projectForViewer, mayReadRun, groupsOf,
} = require('./access');

const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    ed: { id: 'ed', organizationId: 'org1', groups: [] },
    vic: { id: 'vic', organizationId: 'org1', groups: '["g-fin"]' },
    ron: { id: 'ron', organizationId: 'org1', groups: [] },
    both: { id: 'both', organizationId: 'org1', groups: ['g-fin'] },
    adm: { id: 'adm', organizationId: 'org1', groups: [] },
    stranger: { id: 'stranger', organizationId: 'org1', groups: [] },
    outsider: { id: 'outsider', organizationId: 'org2', groups: ['g-fin'] },
    otherAdmin: { id: 'otherAdmin', organizationId: 'org2', groups: [] },
};
const SHARES = [
    { principalType: 'user', principalId: 'ed', role: 'edit' },
    { principalType: 'group', principalId: 'g-fin', role: 'view' },
    { principalType: 'user', principalId: 'ron', role: 'run' },
    { principalType: 'user', principalId: 'both', role: 'run' },
    { principalType: 'user', principalId: 'outsider', role: 'edit' },
];
const A = { id: 'a1', userId: 'owner', organizationId: 'org1', definition: { trigger: { kind: 'manual', id: 't' }, steps: [{ id: 's1' }] }, builderSession: { turns: 3 } };

function build({ shares = SHARES, users = USERS, admins = ['adm', 'otherAdmin'], failShares = false } = {}) {
    const calls = { getUser: 0, hasPermission: 0, listShares: 0 };
    const access = makeAutomationAccess({
        store: {
            async listSharesForAutomation() {
                calls.listShares++;
                if (failShares) throw new Error('db down');
                return shares;
            },
        },
        getUser: async (id) => { calls.getUser++; return users[id] || null; },
        hasPermission: async (id, perm) => { calls.hasPermission++; return perm === 'manage_automations' && admins.includes(id); },
    });
    return { access, calls };
}

test('the owner is the owner, without a single lookup', async () => {
    const { access, calls } = build();
    assert.deepStrictEqual(await access.roleFor(A, 'owner'), { role: 'owner', via: 'owner' });
    assert.deepStrictEqual(calls, { getUser: 0, hasPermission: 0, listShares: 0 });
});

test('user and group shares grant their role; the strongest share wins', async () => {
    const { access } = build();
    assert.deepStrictEqual(await access.roleFor(A, 'ed'), { role: 'edit', via: 'share' });
    assert.deepStrictEqual(await access.roleFor(A, 'vic'), { role: 'view', via: 'share' }, 'groups as JSON text');
    assert.deepStrictEqual(await access.roleFor(A, 'ron'), { role: 'run', via: 'share' });
    assert.deepStrictEqual(await access.roleFor(A, 'both'), { role: 'view', via: 'share' }, 'run directly + view via group = view');
    assert.deepStrictEqual(await access.roleFor(A, 'stranger'), { role: null, via: null });
});

test('an org admin with manage_automations has owner-level access, in their own organisation only', async () => {
    const { access } = build();
    assert.deepStrictEqual(await access.roleFor(A, 'adm'), { role: 'owner', via: 'admin' });
    assert.deepStrictEqual(await access.roleFor(A, 'otherAdmin'), { role: null, via: null });
});

test('a share never crosses organisations', async () => {
    const { access } = build();
    assert.deepStrictEqual(await access.roleFor(A, 'outsider'), { role: null, via: null });
});

test("an org-less automation is judged in its owner's organisation", async () => {
    const { access } = build();
    const orgless = { ...A, organizationId: null };
    assert.strictEqual((await access.roleFor(orgless, 'ed')).role, 'edit');
    assert.strictEqual((await access.roleFor(orgless, 'outsider')).role, null);
    const ownerless = { ...A, organizationId: null, userId: 'ghost' };
    assert.strictEqual((await access.roleFor(ownerless, 'ed')).role, null, 'no organisation at all: nobody but the owner');
});

test('a lookup that fails is no role, never a guess', async () => {
    const { access } = build({ failShares: true });
    assert.deepStrictEqual(await access.roleFor(A, 'ed'), { role: null, via: null });
    const throwingUsers = makeAutomationAccess({
        store: { listSharesForAutomation: async () => SHARES },
        getUser: async () => { throw new Error('users down'); },
        hasPermission: async () => true,
    });
    assert.deepStrictEqual(await throwingUsers.roleFor(A, 'ed'), { role: null, via: null });
    assert.deepStrictEqual(await throwingUsers.roleFor(null, 'ed'), { role: null, via: null });
    assert.deepStrictEqual(await throwingUsers.roleFor(A, null), { role: null, via: null });
});

test('roleSatisfies: run < view < edit < owner', () => {
    const order = ['run', 'view', 'edit', 'owner'];
    for (const [i, role] of order.entries()) {
        for (const [j, need] of order.entries()) {
            assert.strictEqual(roleSatisfies(role, need), i >= j, `${role} vs ${need}`);
        }
    }
    assert.strictEqual(roleSatisfies(null, 'run'), false);
    assert.strictEqual(roleSatisfies('owner', 'admin'), false);
    assert.strictEqual(strongestRole(['run', 'edit', 'view']), 'edit');
    assert.strictEqual(strongestRole(['nonsense']), null);
    assert.deepStrictEqual(groupsOf({ groups: 'not json' }), []);
});

test('canAccessAutomation answers the matrix per need', async () => {
    const { access } = build();
    const expect = {
        owner: { run: true, view: true, edit: true, owner: true },
        adm: { run: true, view: true, edit: true, owner: true },
        ed: { run: true, view: true, edit: true, owner: false },
        vic: { run: true, view: true, edit: false, owner: false },
        ron: { run: true, view: false, edit: false, owner: false },
        stranger: { run: false, view: false, edit: false, owner: false },
    };
    for (const [user, needs] of Object.entries(expect)) {
        for (const [need, want] of Object.entries(needs)) {
            assert.strictEqual(await access.canAccessAutomation(A, { id: user }, need), want, `${user} ${need}`);
        }
    }
});

test('projectForViewer: myRole, no builder chat for others, triggers only for run', () => {
    const own = projectForViewer(A, { role: 'owner', via: 'owner' });
    assert.strictEqual(own.myRole, 'owner');
    assert.deepStrictEqual(own.builderSession, { turns: 3 });
    const admin = projectForViewer(A, { role: 'owner', via: 'admin' });
    assert.strictEqual(admin.builderSession, null);
    const viewer = projectForViewer(A, { role: 'view', via: 'share' });
    assert.deepStrictEqual(viewer.definition, A.definition);
    assert.strictEqual(viewer.builderSession, null);
    const runner = projectForViewer(A, { role: 'run', via: 'share' });
    assert.deepStrictEqual(runner.definition, { trigger: A.definition.trigger });
    assert.strictEqual(runner.definitionRedacted, true);
    assert.deepStrictEqual(A.definition.steps, [{ id: 's1' }], 'the stored row is not touched');
});

test('mayReadRun: view reads every run, run only the runs it started', () => {
    const mine = { id: 'r1', startedByUserId: 'ron' };
    const theirs = { id: 'r2', startedByUserId: 'owner' };
    assert.strictEqual(mayReadRun(mine, { role: 'run' }, 'ron'), true);
    assert.strictEqual(mayReadRun(theirs, { role: 'run' }, 'ron'), false);
    assert.strictEqual(mayReadRun({ id: 'r3', startedByUserId: null }, { role: 'run' }, 'ron'), false);
    assert.strictEqual(mayReadRun(theirs, { role: 'view' }, 'vic'), true);
    assert.strictEqual(mayReadRun(theirs, { role: null }, 'x'), false);
});

test('guard answers 403 with the needed role, and hands back the access otherwise', async () => {
    const { access } = build();
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    const denied = await access.guard({ session: { user: { id: 'vic' } } }, res, A, 'edit');
    assert.strictEqual(denied, null);
    assert.strictEqual(res.statusCode, 403);
    assert.deepStrictEqual(res.body, { error: 'Forbidden', code: 'automation_forbidden', need: 'edit' });
    const res2 = { status() { throw new Error('must not answer'); } };
    assert.deepStrictEqual(await access.guard({ session: { user: { id: 'ed' } } }, res2, A, 'edit'), { role: 'edit', via: 'share' });
});
