'use strict';

/**
 * Who and what a paused run continues as (backgroundRunIdentity.mts): each line of its rule,
 * with the stores injected. The same rule against the real stores is in
 * routes/studioAppBackground.test.js.
 *
 * Run: cd server && node --test appStudio/backgroundRunIdentity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { loadResumeContext } = require('./backgroundRunIdentity.mts');

const ACTIONS = {
    act_run: { kind: 'sequence', runOn: 'server', steps: [{ kind: 'call_action', actionId: 'act_part' }] },
    act_part: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 't', values: {} }] },
    act_other: { kind: 'sequence', steps: [{ kind: 'toast', message: 'x' }] },
};
const DEF = { screens: [], actions: ACTIONS };
const row = (over = {}) => ({ id: 'sar_1', appId: 'app_1', ownerUserId: 'owner', viewerUserId: 'member', actionId: 'act_run', draft: false, definitionVersion: 3, ...over });
const meta = (over = {}) => ({ role: 'agent', activeMs: 0, written: [], ...over });

/** A world in which the run may continue; a test changes one thing. */
function world(over = {}) {
    const w = {
        app: { id: 'app_1', userId: 'owner', name: 'Desk', organizationId: 'org_1', isPublished: true, definition: DEF, publishedDefinition: DEF },
        users: { owner: { id: 'owner', status: 'active', organizationId: 'org_1' }, member: { id: 'member', status: 'active', organizationId: 'org_1', email: 'm@x.test', username: 'mem' } },
        canRead: true, role: 'agent', access: { referenced: true, allowed: true },
        ...over,
    };
    return {
        getApp: async () => w.app,
        getUser: async (id) => w.users[id] ?? null,
        isActiveAccount: (u) => !!u && (!u.status || u.status === 'active'),
        audienceOf: async () => ({ userGroups: ['g1'], orgIds: ['org_1'] }),
        canReadApp: async () => w.canRead,
        getModel: async () => ({ tables: [] }),
        resolveRole: async () => w.role,
        roleAccess: () => w.access,
    };
}
const refusal = async (deps, r = row(), m = meta()) => {
    const out = await loadResumeContext(r, m, deps);
    assert.equal(out.ok, false, 'the run must be refused');
    return out.code;
};

test('nothing changed: the run continues as its starter, on the published definition, with the role it started with', async () => {
    const out = await loadResumeContext(row(), meta(), world());
    assert.equal(out.ok, true);
    assert.equal(out.input.viewer.id, 'member');
    assert.equal(out.input.viewer.email, 'm@x.test');
    assert.equal(out.input.role, 'agent');
    assert.equal(out.input.isOwner, false);
    assert.equal(out.input.def, DEF);
    assert.equal(out.input.definitionVersion, 3);
    assert.deepEqual(out.input.scope, {}, 'the scope comes from the stored walk, never from here');
});

test('rule 1: the app is gone, or its owner is not active', async () => {
    assert.equal(await refusal(world({ app: null })), 'app_gone');
    assert.equal(await refusal(world({ users: { owner: { id: 'owner', status: 'suspended' }, member: { id: 'member' } } })), 'owner_inactive');
});

test('rule 2: no starter (an anonymous run, an erased account), or a starter who is not active', async () => {
    assert.equal(await refusal(world(), row({ viewerUserId: null })), 'starter_gone');
    assert.equal(await refusal(world({ users: { owner: { id: 'owner' } } })), 'starter_gone');
    assert.equal(await refusal(world({ users: { owner: { id: 'owner' }, member: { id: 'member', status: 'suspended' } } })), 'starter_gone');
});

test('rule 3: the starter can no longer open the app', async () => {
    assert.equal(await refusal(world({ canRead: false })), 'no_access');
    const unpublished = { id: 'app_1', userId: 'owner', isPublished: false, definition: DEF, publishedDefinition: DEF };
    assert.equal(await refusal(world({ canRead: false, app: unpublished })), 'unpublished');
});

test('rule 4: a draft run is the owner\'s; a published run needs the app published', async () => {
    assert.equal(await refusal(world(), row({ draft: true })), 'no_access');
    const ownerRun = await loadResumeContext(row({ draft: true, viewerUserId: 'owner' }), meta({ role: 'owner' }), world({ role: 'owner' }));
    assert.equal(ownerRun.ok, true);
    assert.equal(ownerRun.input.isOwner, true);
    // The owner of an unpublished app: their published run still has nothing to continue on.
    const unpublished = { id: 'app_1', userId: 'owner', isPublished: false, definition: DEF, publishedDefinition: null };
    assert.equal(await refusal(world({ app: unpublished, role: 'owner' }), row({ viewerUserId: 'owner' }), meta({ role: 'owner' })), 'unpublished');
});

test('rule 5: an edited action does not end the run; a removed one does; what it calls may change or go', async () => {
    const withActions = (actions) => world({ app: { id: 'app_1', userId: 'owner', isPublished: true, publishedDefinition: { screens: [], actions } } });
    const ok = async (actions, why) => assert.equal((await loadResumeContext(row(), meta(), withActions(actions))).ok, true, why);
    await ok({ ...ACTIONS, act_run: { kind: 'sequence', runOn: 'server', steps: [{ kind: 'toast', message: 'new' }] } }, 'the action was edited');
    await ok({ ...ACTIONS, act_part: { kind: 'sequence', steps: [{ kind: 'create_record', tableId: 'other', values: {} }] } }, 'an action it calls was edited');
    await ok({ act_run: ACTIONS.act_run }, 'an action it calls was removed');
    await ok({ ...ACTIONS, act_run: { kind: 'sequence', steps: ACTIONS.act_run.steps } }, 'no longer a server run');
    await ok({ ...ACTIONS, act_run: { kind: 'toast', message: 'x' } }, 'no longer a sequence');
    const { act_run: _gone, ...without } = ACTIONS;
    assert.equal(await refusal(withActions(without)), 'action_removed');
    assert.equal(await refusal(withActions({})), 'action_removed');
    // The definition handed on is today's: the runner takes the steps from the run's snapshot, everything else from here.
    const edited = { ...ACTIONS, act_run: { kind: 'sequence', runOn: 'server', steps: [] } };
    const out = await loadResumeContext(row(), meta(), withActions(edited));
    assert.equal(out.input.def.actions, edited);
});

test('rule 6: the role today is the role the run started with, and it still reaches the action', async () => {
    assert.equal(await refusal(world({ role: 'manager' })), 'role_changed', 'promoted');
    assert.equal(await refusal(world({ role: null })), 'role_changed', 'removed');
    assert.equal(await refusal(world({ access: { referenced: true, allowed: false } })), 'role_denied');
    assert.equal(await refusal(world({ access: { referenced: false, allowed: false } })), 'role_denied', 'an action nothing wires is the owner\'s alone, as at the start');
});

test('a refusal names no person', async () => {
    for (const deps of [world({ canRead: false }), world({ role: null }), world({ app: null })]) {
        const out = await loadResumeContext(row(), meta(), deps);
        assert.equal(/member|owner@|m@x/.test(out.error), false, out.error);
    }
});
