/**
 * automation/agentBinding.js: who may link an agent_call automation to an
 * agent, what the trigger panel may show, and the dispatch-time question.
 *
 * Every dependency goes in as an argument (no module mocking). The agent edit
 * rule is the REAL one (agents/agentAccess.js) over fake permissions, so the
 * gate is tested against the rules it actually enforces.
 *
 * Proven:
 *   - the gate needs EDIT on the automation, EDIT on each agent, and an owner
 *     who may use the agent; each missing piece is refused, and an unknown
 *     agent and a not-yours agent get the very same answer;
 *   - removing a link needs edit rights on the agent as well, and a link to an
 *     agent the caller cannot edit is left alone, not shown, not touched;
 *   - the listing names only agents the viewer may edit;
 *   - the run-time check is fail-closed.
 *
 * Run: cd server && node --test automation/agentBinding.test.js
 */

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const log = require('../telemetry/log');
const { makeAutomationAccess } = require('./access');
const { makeAgentAccess } = require('../agents/agentAccess');
const binding = require('./agentBinding');

// ── The world ────────────────────────────────────────────────────────
const USERS = {
    owner: { id: 'owner', organizationId: 'org1', groups: [] },
    ed: { id: 'ed', organizationId: 'org1', groups: [] },         // edit share on the automation
    viewer: { id: 'viewer', organizationId: 'org1', groups: [] }, // view share only
    adm: { id: 'adm', organizationId: 'org1', groups: [] },       // manage_agents + manage_automations
    zed: { id: 'zed', organizationId: 'org1', groups: [] },       // owns agents, no rights on the automation
    other: { id: 'other', organizationId: 'org2', groups: [] },
};
const SHARES = [
    { principalType: 'user', principalId: 'ed', role: 'edit' },
    { principalType: 'user', principalId: 'viewer', role: 'view' },
];
const PERMISSIONS = { adm: ['manage_agents', 'manage_automations'] };

const published = (over) => ({ is_published: 1, published_version: 1, organization_id: 'org1', shared_groups: [], ...over });
const AGENTS = {
    a_own: published({ id: 'a_own', name: 'Owner agent', owner_id: 'owner' }),
    a_ed_pub: published({ id: 'a_ed_pub', name: 'Ed agent', owner_id: 'ed' }),
    a_ed_draft: { id: 'a_ed_draft', name: 'Ed draft', owner_id: 'ed', is_published: 0, published_version: 0, organization_id: 'org1' },
    a_zed: published({ id: 'a_zed', name: 'Zed agent', owner_id: 'zed' }),
    a_zed_draft: { id: 'a_zed_draft', name: 'Zed draft', owner_id: 'zed', is_published: 0, published_version: 0, organization_id: 'org1' },
    a_curated: published({ id: 'a_curated', name: 'Curated', owner_id: 'owner', config: { tools: { automations: { auto2: { confirm: 'ask' } } } } }),
    a_all_off: published({ id: 'a_all_off', name: 'All off', owner_id: 'owner', config: { tools: { automations: {} } } }),
    a_other_org: published({ id: 'a_other_org', name: 'Other org', owner_id: 'other', organization_id: 'org2' }),
};

let automations;
let bindings;      // automationId -> [{ agentId, createdBy }]
let writes;
let logged;

const agentAccess = makeAgentAccess({
    hasPermission: async (userId, perm) => (PERMISSIONS[userId] || []).includes(perm),
    resolveUserOrgIds: async (req) => new Set([USERS[req.session.user.id].organizationId]),
    getUser: async (id) => USERS[id] || null,
    roles: () => ({ SystemRoles: { SUPER_ADMIN: 'admin' }, OrgRoles: { AGENT_EDITOR: 'agent_editor' } }),
});

function makeDeps() {
    const store = {
        async listBindingsForAutomation(id) { return (bindings[id] || []).map((b) => ({ automationId: id, ...b })); },
        async applyAgentBindings(id, { add = [], remove = [] }, by) {
            writes.push({ id, add, remove, by });
            const kept = (bindings[id] || []).filter((b) => !remove.includes(b.agentId));
            for (const agentId of add) if (!kept.some((b) => b.agentId === agentId)) kept.push({ agentId, createdBy: by });
            bindings[id] = kept;
            return kept.map((b) => ({ automationId: id, ...b }));
        },
        async listAutomationsBoundToAgent(agentId) {
            return Object.entries(bindings)
                .filter(([, list]) => list.some((b) => b.agentId === agentId))
                .map(([id]) => automations[id]);
        },
        async hasAgentBinding(id, agentId) { return (bindings[id] || []).some((b) => b.agentId === agentId); },
    };
    return {
        store,
        agentStore: {
            async getForRuntime(id) { return AGENTS[id] ? { ...AGENTS[id] } : null; },
            async getAgents(userId) { return Object.values(AGENTS).filter((a) => a.owner_id === userId).map((a) => ({ ...a })); },
            async getPublishedAgentsForUser() { return Object.values(AGENTS).filter((a) => a.is_published && a.organization_id === 'org1').map((a) => ({ ...a })); },
            async getPublishedAgents() { return Object.values(AGENTS).filter((a) => a.is_published).map((a) => ({ ...a })); },
        },
        userStore: { async getUser(id) { return USERS[id] || null; } },
        access: makeAutomationAccess({
            store: { listSharesForAutomation: async () => SHARES },
            getUser: async (id) => USERS[id] || null,
            hasPermission: async (userId, perm) => (PERMISSIONS[userId] || []).includes(perm),
        }),
        agentAccess,
    };
}

const agentCall = (over = {}) => ({
    id: 'auto1', userId: 'owner', organizationId: 'org1', kind: 'automation', isActive: true,
    definition: { trigger: { kind: 'agent_call', toolName: 'send_invoice', description: 'd' } },
    ...over,
});

let realInfo;
beforeEach(() => {
    automations = { auto1: agentCall(), auto2: agentCall({ id: 'auto2', definition: { trigger: { kind: 'agent_call', toolName: 'send_invoice' } } }) };
    bindings = {};
    writes = [];
    logged = [];
    if (!realInfo) realInfo = log.info;
    log.info = (...a) => { logged.push(a.join(' ')); };
});
process.on('exit', () => { if (realInfo) log.info = realInfo; });

const set = (actorId, agentIds, over = {}) => binding.setAgentBindings({
    automation: over.automation || automations.auto1, agentIds, actorId, deps: makeDeps(),
});
const refusal = async (promise) => {
    try { await promise; } catch (e) { return e; }
    assert.fail('expected a refusal');
    return null;
};

// ── The write gate ───────────────────────────────────────────────────

test('the owner links an agent the owner may use; the row records who and the audit line names ids only', async () => {
    const out = await set('owner', ['a_own']);
    assert.deepStrictEqual(out.added, ['a_own']);
    assert.deepStrictEqual(writes, [{ id: 'auto1', add: ['a_own'], remove: [], by: 'owner' }]);
    assert.ok(logged.some((l) => /bound automation=auto1 agent=a_own actor=owner/.test(l)));
    assert.ok(logged.every((l) => !/@|name|title/i.test(l)), 'ids only: no names, no personal data');
});

test('EDIT on the automation is required: a view-only sharee, a stranger and another organisation are refused', async () => {
    for (const actor of ['viewer', 'zed', 'other']) {
        const e = await refusal(set(actor, ['a_own']));
        assert.strictEqual(e.status, 403, actor);
        assert.strictEqual(e.code, 'automation_forbidden', actor);
    }
    assert.deepStrictEqual(writes, []);
});

test('EDIT on the agent is required: an edit sharee cannot link an agent they cannot edit', async () => {
    const e = await refusal(set('ed', ['a_own']));
    assert.strictEqual(e.status, 403);
    assert.strictEqual(e.code, 'agent_not_linkable');
    assert.deepStrictEqual(writes, []);
});

test('an agent that does not exist and one the caller may not edit get the SAME answer', async () => {
    const notYours = await refusal(set('ed', ['a_zed']));
    const missing = await refusal(set('ed', ['a_does_not_exist']));
    const otherOrg = await refusal(set('ed', ['a_other_org']));
    for (const e of [notYours, missing, otherOrg]) {
        assert.strictEqual(e.status, 403);
        assert.strictEqual(e.code, 'agent_not_linkable');
        assert.strictEqual(e.message, notYours.message);
    }
});

test('an edit sharee links an agent they can edit when the owner may use it too', async () => {
    const out = await set('ed', ['a_ed_pub']);
    assert.deepStrictEqual(out.added, ['a_ed_pub']);
    assert.strictEqual(writes[0].by, 'ed');
});

test('the OWNER must be allowed to use the agent: a draft the owner cannot use is refused even to someone who can edit it', async () => {
    const e = await refusal(set('ed', ['a_ed_draft']));
    assert.strictEqual(e.status, 403);
    assert.strictEqual(e.code, 'agent_owner_cannot_use');
    assert.deepStrictEqual(writes, []);
});

test('an admin cannot mint a grant the owner never could: they edit the agent and the automation, the owner cannot use it', async () => {
    const e = await refusal(set('adm', ['a_zed_draft']));
    assert.strictEqual(e.code, 'agent_owner_cannot_use');
    // ...while the same admin may link an agent the owner CAN use.
    const ok = await set('adm', ['a_zed']);
    assert.deepStrictEqual(ok.added, ['a_zed']);
});

test('the automation must be an agent tool before an agent is linked; unlinking never needs that', async () => {
    const manual = agentCall({ definition: { trigger: { kind: 'manual' } } });
    const e = await refusal(set('owner', ['a_own'], { automation: manual }));
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'not_agent_call');
    bindings.auto1 = [{ agentId: 'a_own', createdBy: 'owner' }];
    const out = await set('owner', [], { automation: manual });
    assert.deepStrictEqual(out.removed, ['a_own']);
});

test('only an automation can be linked, not a Step or a flowlet', async () => {
    const step = agentCall({ kind: 'block' });
    const e = await refusal(set('owner', ['a_own'], { automation: step }));
    assert.strictEqual(e.code, 'not_an_automation');
});

test('two automations of one agent cannot share a tool name', async () => {
    bindings.auto2 = [{ agentId: 'a_own', createdBy: 'owner' }];
    const e = await refusal(set('owner', ['a_own']));
    assert.strictEqual(e.status, 409);
    assert.strictEqual(e.code, 'tool_name_taken');
    assert.deepStrictEqual(writes, []);
});

test('the list is validated: an array of ids, at most 50', async () => {
    assert.strictEqual((await refusal(set('owner', 'a_own'))).code, 'agent_bindings_invalid');
    assert.strictEqual((await refusal(set('owner', [3]))).code, 'agent_bindings_invalid');
    assert.strictEqual((await refusal(set('owner', Array.from({ length: 51 }, (_, i) => `a${i}`)))).code, 'agent_bindings_invalid');
});

test('saving the same list again writes nothing', async () => {
    await set('owner', ['a_own']);
    writes.length = 0;
    const again = await set('owner', ['a_own', 'a_own']);
    assert.deepStrictEqual(again.added, []);
    assert.deepStrictEqual(writes, []);
});

// ── Unlinking ────────────────────────────────────────────────────────

test('unlinking needs edit rights on the agent too: a link to an agent the caller cannot edit stays', async () => {
    bindings.auto1 = [{ agentId: 'a_own', createdBy: 'owner' }, { agentId: 'a_ed_pub', createdBy: 'ed' }];
    // 'ed' sends the editable set without either: only the one they can edit goes.
    const out = await set('ed', []);
    assert.deepStrictEqual(out.removed, ['a_ed_pub']);
    assert.strictEqual(out.kept, 1);
    assert.deepStrictEqual(bindings.auto1.map((b) => b.agentId), ['a_own']);
    assert.ok(logged.some((l) => /unbound automation=auto1 agent=a_ed_pub actor=ed/.test(l)));
});

test('a link to an agent that no longer exists can be cleared by whoever edits the automation', async () => {
    bindings.auto1 = [{ agentId: 'a_gone', createdBy: 'owner' }];
    const out = await set('ed', []);
    assert.deepStrictEqual(out.removed, ['a_gone']);
});

// ── What the trigger panel shows ─────────────────────────────────────

test('the listing names only agents the viewer may edit; the rest is an anonymous "another agent"', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }, { agentId: 'a_ed_pub' }];
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'ed', deps: makeDeps() });
    assert.deepStrictEqual(view.bindings, [
        { agentId: null, name: null, canEdit: false, missing: false, usable: null, notGranted: null },
        { agentId: 'a_ed_pub', name: 'Ed agent', canEdit: true, missing: false, usable: true, notGranted: false },
    ]);
    assert.strictEqual(JSON.stringify(view).includes('Owner agent'), false, 'the name of an agent the viewer cannot edit never leaves');
    assert.strictEqual(JSON.stringify(view).includes('a_own'), false, 'neither does its id');
});

test('the candidates are the agents the viewer can edit AND the owner can use', async () => {
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'ed', deps: makeDeps() });
    assert.deepStrictEqual(view.candidates.map((c) => c.id), ['a_ed_pub'], 'not the draft the owner cannot use, not the owner\'s own agent');
    assert.strictEqual(view.canManage, true);
    assert.strictEqual(view.isAgentCall, true);
    assert.strictEqual(view.toolName, 'send_invoice');
});

test('a viewer without edit rights sees the links and cannot pick anything', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }];
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'viewer', deps: makeDeps() });
    assert.strictEqual(view.canManage, false);
    assert.deepStrictEqual(view.candidates, []);
    assert.deepStrictEqual(view.bindings.map((b) => b.agentId), [null]);
});

test('a link whose agent the owner can no longer use is marked unusable, with the name for those who may edit it', async () => {
    bindings.auto1 = [{ agentId: 'a_ed_draft' }];
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'ed', deps: makeDeps() });
    assert.deepStrictEqual(view.bindings[0], { agentId: 'a_ed_draft', name: 'Ed draft', canEdit: true, missing: false, usable: false, notGranted: false });
});

test('candidates that cannot be read are null, never an empty list', async () => {
    const deps = makeDeps();
    deps.agentStore.getAgents = async () => { throw new Error('db down'); };
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'ed', deps });
    assert.strictEqual(view.candidates, null);
    assert.strictEqual(view.candidatesError, 'agents_unavailable');
});

test('a link the agent\'s own list leaves out is flagged notGranted; an uncurated agent is not', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }, { agentId: 'a_curated' }, { agentId: 'a_all_off' }];
    const view = await binding.describeBindings({ automation: automations.auto1, viewerId: 'owner', deps: makeDeps() });
    const flag = (id) => view.bindings.find((b) => b.agentId === id).notGranted;
    assert.strictEqual(flag('a_own'), false, 'nobody curated it: the link alone is the grant');
    assert.strictEqual(flag('a_curated'), true, 'the list names auto2 only');
    assert.strictEqual(flag('a_all_off'), true, 'an empty list is "all switched off"');
    bindings.auto2 = [{ agentId: 'a_curated' }];
    const other = await binding.describeBindings({ automation: automations.auto2, viewerId: 'owner', deps: makeDeps() });
    assert.strictEqual(other.bindings[0].notGranted, false, 'granted and linked');
});

test('linkedAutomationIds: only for someone who may edit the agent, the same null otherwise', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }];
    bindings.auto2 = [{ agentId: 'a_own' }, { agentId: 'a_zed' }];
    const ids = (agentId, viewerId) => binding.linkedAutomationIds({ agentId, viewerId, deps: makeDeps() });
    assert.deepStrictEqual((await ids('a_own', 'owner')).sort(), ['auto1', 'auto2']);
    assert.strictEqual(await ids('a_own', 'ed'), null, 'not theirs to edit');
    assert.strictEqual(await ids('no_such_agent', 'owner'), null, 'same answer for an agent that does not exist');
    assert.strictEqual(await ids('a_own', null), null);
});

// ── The dispatch-time question ───────────────────────────────────────

test('agentMayCall: a bound agent the owner may use is allowed; every other case is a named no', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }, { agentId: 'a_ed_draft' }];
    const ask = (agentId, deps = makeDeps()) => binding.agentMayCall({ automation: automations.auto1, agentId, deps });
    assert.deepStrictEqual(await ask('a_own'), { ok: true });
    assert.deepStrictEqual(await ask(null), { ok: false, reason: 'no_agent' });
    assert.deepStrictEqual(await ask('a_zed'), { ok: false, reason: 'not_bound' });
    assert.deepStrictEqual(await ask('a_ed_draft'), { ok: false, reason: 'owner_cannot_use' });
});

test('agentMayCall fails closed when the lookups throw', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }];
    const noStore = makeDeps();
    noStore.store.hasAgentBinding = async () => { throw new Error('db down'); };
    assert.deepStrictEqual(await binding.agentMayCall({ automation: automations.auto1, agentId: 'a_own', deps: noStore }), { ok: false, reason: 'not_bound' });
    const noAgents = makeDeps();
    noAgents.agentStore.getForRuntime = async () => { throw new Error('db down'); };
    assert.deepStrictEqual(await binding.agentMayCall({ automation: automations.auto1, agentId: 'a_own', deps: noAgents }), { ok: false, reason: 'owner_cannot_use' });
});

// ── After the owner changes ──────────────────────────────────────────

test('a new owner keeps only the links to agents they may use', async () => {
    bindings.auto1 = [{ agentId: 'a_own' }, { agentId: 'a_zed' }];
    // 'zed' now owns the automation: a_zed is theirs, a_own is published to the org and still usable by them.
    const moved = { ...automations.auto1, userId: 'zed' };
    assert.deepStrictEqual(await binding.pruneBindingsForOwner({ automation: moved, actorId: 'owner', deps: makeDeps() }), []);
    // 'other' sits in another organisation: neither agent is usable for them.
    const away = { ...automations.auto1, userId: 'other' };
    const dropped = await binding.pruneBindingsForOwner({ automation: away, actorId: 'owner', deps: makeDeps() });
    assert.deepStrictEqual(dropped.sort(), ['a_own', 'a_zed']);
    assert.deepStrictEqual(bindings.auto1, []);
    assert.ok(logged.some((l) => /reason=new_owner_cannot_use/.test(l)));
});

// ── The agent's own curation, on top of the link ─────────────────────

test('agentGrantVerdict: uncurated agents are untouched; a curated one runs only what it lists, and "ask" needs a confirm layer', async () => {
    const ask = (agentId, automation = automations.auto2, confirmed = false, deps = makeDeps()) =>
        binding.agentGrantVerdict({ automation, agentId, confirmed, deps });
    assert.deepStrictEqual(await ask('a_own'), { ok: true });
    assert.deepStrictEqual(await ask('a_curated', automations.auto1), { ok: false, reason: 'not_granted' });
    assert.deepStrictEqual(await ask('a_all_off'), { ok: false, reason: 'not_granted' });
    assert.deepStrictEqual(await ask('a_curated'), { ok: false, reason: 'needs_confirmation' });
    assert.deepStrictEqual(await ask('a_curated', automations.auto2, true), { ok: true });
});

test('agentGrantVerdict fails closed: no agent, a missing agent, an unreadable store', async () => {
    const base = { automation: automations.auto1, confirmed: false };
    assert.deepStrictEqual(await binding.agentGrantVerdict({ ...base, agentId: null, deps: makeDeps() }), { ok: false, reason: 'agent_unreadable' });
    assert.deepStrictEqual(await binding.agentGrantVerdict({ ...base, agentId: 'nope', deps: makeDeps() }), { ok: false, reason: 'agent_unreadable' });
    const broken = makeDeps();
    broken.agentStore.getForRuntime = async () => { throw new Error('db down'); };
    assert.deepStrictEqual(await binding.agentGrantVerdict({ ...base, agentId: 'a_own', deps: broken }), { ok: false, reason: 'agent_unreadable' });
});
