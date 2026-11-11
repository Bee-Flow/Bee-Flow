'use strict';

/**
 * Who and what an unattended run is (unattendedIdentity.mts), one test per rule in its header,
 * each reader injected. The same rule at a resume of a trigger run that was on hold.
 *
 * Run: cd server && node --test appStudio/triggers/unattendedIdentity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadUnattendedContext, loadUnattendedResumeContext } = require('./unattendedIdentity.mts');
const { triggerFingerprint } = require('./triggerSpec.mts');

const write = (tableId) => ({ kind: 'create_record', tableId, values: {} });
const TRIGGER = { id: 'tick', kind: 'schedule', actionId: 'act_job', schedule: { everyMinutes: 15 } };
const DEF = {
    schemaVersion: 3,
    actions: { act_job: { kind: 'sequence', steps: [write('log'), { kind: 'call_action', actionId: 'act_sub' }] }, act_sub: write('sub') },
    triggers: [TRIGGER],
};
const APP = { id: 'app_1', userId: 'owner', name: 'Desk', organizationId: 'org_1', isPublished: true, publishedDefinition: DEF, publishedVersion: 7, definition: { draft: true } };
const OWNER = { id: 'owner', username: 'olga', name: 'Olga Owner', email: 'olga@example.test', organizationId: 'org_1', status: 'active' };
const ARMED = { appId: 'app_1', triggerId: 'tick', ownerUserId: 'owner', fingerprint: triggerFingerprint(DEF, TRIGGER) };

/** Every reader, answering the happy case; `over` replaces what a test changes. `asked` records what was read. */
function deps(over = {}) {
    const asked = [];
    return {
        asked,
        getApp: async (id) => { asked.push(`app:${id}`); return 'app' in over ? over.app : APP; },
        getUser: async (id) => { asked.push(`user:${id}`); return 'owner' in over ? over.owner : OWNER; },
        isActiveAccount: (u) => !!u && (!u.status || u.status === 'active'),
        hasAppStudio: async (who) => { asked.push(`capability:${who.userId}:${who.orgId}`); return over.capability ?? true; },
        getModel: async () => over.model ?? { tables: [] },
        resolveRole: async (app, userId) => { asked.push(`role:${userId}`); return 'role' in over ? over.role : (app.userId === userId ? 'owner' : null); },
    };
}
const refusal = async (over, armed = ARMED) => {
    const out = await loadUnattendedContext(armed, deps(over));
    assert.equal(out.ok, false);
    return [out.code, out.stale];
};

test('the happy case: the run is the owner, on the published definition, with role owner and no draft', async () => {
    const d = deps();
    const out = await loadUnattendedContext(ARMED, d);
    assert.equal(out.ok, true);
    const { input } = out;
    assert.equal(input.def, DEF, 'the published copy, never the draft');
    assert.deepEqual(input.viewer, { id: 'owner', name: 'Olga Owner', email: 'olga@example.test', organizationId: 'org_1' }, 'viewer.* is the owner');
    assert.deepEqual([input.role, input.isOwner, input.draft, input.definitionVersion, input.actionId], ['owner', true, false, 7, 'act_job']);
    assert.deepEqual(input.unattended, { refusedKinds: [] }, 'the run is marked unattended: its host refuses page steps');
    assert.deepEqual(input.scope, {});
    assert.equal(out.trigger.id, 'tick');
    assert.deepEqual(d.asked, ['app:app_1', 'user:owner', 'capability:owner:org_1', 'role:owner'], 'everything is read at the fire');
});

test('rule 1: no app, an unpublished app or one without a published copy is stale', async () => {
    assert.deepEqual(await refusal({ app: null }), ['app_gone', true]);
    assert.deepEqual(await refusal({ app: { ...APP, isPublished: false } }), ['unpublished', true]);
    assert.deepEqual(await refusal({ app: { ...APP, publishedDefinition: null } }), ['unpublished', true]);
});

test('rule 2: another owner than the trigger was armed for is stale; a missing or inactive owner holds the fire back', async () => {
    assert.deepEqual(await refusal({ app: { ...APP, userId: 'someone_else' } }), ['owner_changed', true]);
    assert.deepEqual(await refusal({ owner: null }), ['owner_inactive', false]);
    assert.deepEqual(await refusal({ owner: { ...OWNER, status: 'deactivated' } }), ['owner_inactive', false]);
    assert.deepEqual(await refusal({ owner: { ...OWNER, status: 'pending' } }), ['owner_inactive', false]);
});

test('rule 3: without App Studio for the owner the fire is held back, and nothing further is read', async () => {
    const d = deps({ capability: false });
    const out = await loadUnattendedContext(ARMED, d);
    assert.deepEqual([out.ok, out.code, out.stale], [false, 'capability_off', false]);
    assert.equal(d.asked.includes('role:owner'), false);
});

test('rule 4: a trigger that left the published copy, was switched off or is of an unknown kind is stale', async () => {
    const without = (triggers) => ({ app: { ...APP, publishedDefinition: { ...DEF, triggers } } });
    assert.deepEqual(await refusal(without(undefined)), ['trigger_gone', true]);
    assert.deepEqual(await refusal(without([{ ...TRIGGER, id: 'other' }])), ['trigger_gone', true]);
    assert.deepEqual(await refusal(without([{ ...TRIGGER, enabled: false }])), ['trigger_gone', true]);
    assert.deepEqual(await refusal(without([{ ...TRIGGER, kind: 'moon_phase' }])), ['definition_changed', true]);
});

test('rule 4: a changed schedule, action or called action is not what was armed', async () => {
    const changed = (patch) => ({ app: { ...APP, publishedDefinition: { ...DEF, ...patch } } });
    assert.deepEqual(await refusal(changed({ triggers: [{ ...TRIGGER, schedule: { everyMinutes: 1 } }] })), ['definition_changed', true]);
    assert.deepEqual(await refusal(changed({ actions: { ...DEF.actions, act_job: { kind: 'sequence', steps: [write('other')] } } })), ['definition_changed', true]);
    assert.deepEqual(await refusal(changed({ actions: { ...DEF.actions, act_sub: write('elsewhere') } })), ['definition_changed', true], 'the action it calls counts');
    assert.deepEqual(await refusal({}, { ...ARMED, fingerprint: 'f'.repeat(64) }), ['definition_changed', true]);
    // What is not part of the trigger does not disarm it.
    assert.equal((await loadUnattendedContext(ARMED, deps(changed({ screens: [{ id: 'new' }], actions: { ...DEF.actions, act_unrelated: write('x') } })))).ok, true);
});

test('rule 5: an action that may not run unattended is refused at the fire, also through a called action', async () => {
    const page = { kind: 'sequence', steps: [write('log'), { kind: 'call_action', actionId: 'act_sub' }] };
    const def = { ...DEF, actions: { act_job: page, act_sub: { kind: 'navigate', screenId: 'home' } } };
    const armed = { ...ARMED, fingerprint: triggerFingerprint(def, TRIGGER) };
    const out = await loadUnattendedContext(armed, deps({ app: { ...APP, publishedDefinition: def } }));
    assert.deepEqual([out.ok, out.code, out.stale], [false, 'not_unattended', false]);
    assert.match(out.error, /navigate step, which cannot run without a person/);
});

test('rule 6: the run is never anyone but the owner: a resolver that answers another role refuses', async () => {
    assert.deepEqual(await refusal({ role: 'agent' }), ['owner_role', false]);
    assert.deepEqual(await refusal({ role: null }), ['owner_role', false]);
});

test('a refusal names no person', async () => {
    for (const over of [{ owner: { ...OWNER, status: 'deactivated' } }, { capability: false }, { app: { ...APP, isPublished: false } }]) {
        const out = await loadUnattendedContext(ARMED, deps(over));
        assert.equal(/olga|Olga|example\.test/.test(out.error), false, out.error);
    }
});

// ── A trigger run that was on hold ──────────────────────────────────────────

const RUN = { id: 'sar_1', appId: 'app_1', ownerUserId: 'owner', viewerUserId: 'owner', actionId: 'act_job', origin: 'trigger', draft: false, triggerId: 'tick' };
const META = { role: 'owner', activeMs: 0, written: [] };

test('a resume goes on as the owner, with the published definition, also when the action was edited meanwhile', async () => {
    const edited = { app: { ...APP, publishedDefinition: { ...DEF, actions: { ...DEF.actions, act_job: write('edited') } } } };
    for (const over of [{}, edited]) {
        const out = await loadUnattendedResumeContext(RUN, META, deps(over));
        assert.equal(out.ok, true);
        assert.deepEqual([out.input.viewer.id, out.input.role, out.input.isOwner, out.input.draft, out.input.actionId], ['owner', 'owner', true, false, 'act_job']);
        assert.deepEqual(out.input.unattended, { refusedKinds: [] }, 'the kept steps are still refused one by one when they need a page');
    }
});

test('a resume is refused when the app, the owner, the trigger or the action is gone', async () => {
    const code = async (over, run = RUN, meta = META) => (await loadUnattendedResumeContext(run, meta, deps(over))).code;
    assert.equal(await code({ app: { ...APP, isPublished: false } }), 'unpublished');
    assert.equal(await code({ owner: { ...OWNER, status: 'deactivated' } }), 'owner_inactive');
    assert.equal(await code({ capability: false }), 'capability_off');
    assert.equal(await code({ app: { ...APP, publishedDefinition: { ...DEF, triggers: [] } } }), 'trigger_gone');
    assert.equal(await code({ app: { ...APP, publishedDefinition: { ...DEF, triggers: [{ ...TRIGGER, enabled: false }] } } }), 'trigger_gone');
    assert.equal(await code({ app: { ...APP, publishedDefinition: { ...DEF, actions: { act_sub: DEF.actions.act_sub } } } }), 'action_removed');
    assert.equal(await code({}, { ...RUN, triggerId: null }), 'trigger_gone');
    assert.equal(await code({}, { ...RUN, draft: true }), 'trigger_gone');
    assert.equal(await code({}, RUN, { ...META, role: 'agent' }), 'trigger_gone', 'a run that did not pause as the owner does not go on as the owner');
    assert.equal(await code({ role: 'agent' }), 'owner_role');
});
