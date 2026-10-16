/**
 * runPolicy.connections = 'caller': whose connections a run uses.
 *
 * Run: cd server && node --test core/automationRunner/callerConnections.test.js
 */

'use strict';

const { test, after } = require('node:test');
require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const lookups = [];
const restore = installResolveStub({
    '../integrations/integrationTools': {
        async getIntegrationTools(opts) { lookups.push(opts); return { tools: [{ function: { name: 'gmail_search' } }] }; },
    },
});
after(() => restore());

const {
    callerOnlyUserId, refusesMissingStarter, collectRequirements, sessionHasProvider, applyCallerOnly, CallerNotConnectedError,
} = require('./callerConnections');
const { toolIdentity, lendPolicyFor, permittedCatalog } = require('./toolIdentity');
const { resolveLendingIdentity, assertStepToolPermitted } = require('./integrationActionGates');

const OWNER = 'owner-1';
const CALLER = 'caller-1';
const ORG = 'org-1';
const providerForTool = (t) => ({ gmail_search: 'google', outlook_send: 'microsoft', nc_list: 'nextcloud', fireflies_get: 'fireflies' }[t] || null);
const sessionWith = (userId, providers) => ({
    user: { id: userId, organizationId: ORG },
    automationProviders: Object.fromEntries(providers.map(p => [p, { accessToken: `tok-${userId}-${p}` }])),
});

test('callerOnlyUserId: only a non-owner starter on a "caller" policy; the owner and unknown starters keep the owner identity', () => {
    const automation = { userId: OWNER };
    assert.strictEqual(callerOnlyUserId({ connections: 'caller' }, automation, CALLER), CALLER);
    assert.strictEqual(callerOnlyUserId({ connections: 'caller' }, automation, OWNER), null);
    assert.strictEqual(callerOnlyUserId({ connections: 'caller' }, automation, null), null);
    assert.strictEqual(callerOnlyUserId({ connections: 'caller' }, automation, { id: CALLER }), null);
    assert.strictEqual(callerOnlyUserId({ connections: 'owner' }, automation, CALLER), null);
    assert.strictEqual(callerOnlyUserId({}, automation, CALLER), null);
});

test('callerOnlyUserId: a run that began in caller mode keeps it after the setting is switched off (never widens)', () => {
    const automation = { userId: OWNER };
    assert.strictEqual(callerOnlyUserId({ connections: 'owner' }, automation, CALLER, 'caller'), CALLER);
    assert.strictEqual(callerOnlyUserId({ connections: 'owner' }, automation, CALLER, 'owner'), null);
});

test('refusesMissingStarter: EVERY start without a person is refused under the caller policy, except the system\'s own kinds', () => {
    const caller = { connections: 'caller' };
    for (const kind of ['studio_app', 'webpage', 'agent_call', 'manual', 'manual_step', 'dry_run', 'some_future_kind']) assert.strictEqual(refusesMissingStarter(caller, kind, null), true, kind);
    for (const kind of ['schedule', 'webhook', 'app_event', 'form', 'email']) assert.strictEqual(refusesMissingStarter(caller, kind, null), false, kind);
    assert.strictEqual(refusesMissingStarter(caller, 'agent_call', CALLER), false);
    assert.strictEqual(refusesMissingStarter({ connections: 'owner' }, 'agent_call', null), false);
    assert.strictEqual(refusesMissingStarter({ connections: 'owner' }, 'agent_call', null, 'caller'), true);
});

test('collectRequirements: nested steps, flowlets, published Steps, an agent behind an AI step, saved HTTP credentials', async () => {
    const def = {
        steps: [
            { type: 'integration_action', tool: 'gmail_search' },
            { type: 'loop', body: [{ type: 'integration_action', tool: 'outlook_send' }] },
            { type: 'integration_action', tool: 'fireflies_get' },
            { type: 'ai_step', id: 'ai1', agentId: 'agent-1' },
            { type: 'call_block', blockId: 'blk-1' },
            { type: 'http_request', id: 'h1', auth: { connectionId: 'conn-1' } },
            { type: 'knowledge_write' },
            { type: 'fill_document', saveCopy: true },
            { type: 'generate_document' },
            { type: 'http_request', id: 'h2', cacheInto: { datatableId: 'dt1' } },
        ],
        layers: { l1: { steps: [{ type: 'integration_action', tool: 'nc_list' }] } },
    };
    const req = await collectRequirements(def, {
        providerForTool,
        loadBlockDefinition: async (id) => (id === 'blk-1' ? { steps: [{ type: 'integration_action', tool: 'withings_x' }] } : null),
        stepProviders: async () => ['withings'],
    });
    assert.deepStrictEqual(req.providers.sort(), ['google', 'microsoft', 'nextcloud', 'withings']);
    assert.deepStrictEqual(req.httpConnections, [{ stepId: 'h1', connectionId: 'conn-1' }]);
    assert.strictEqual(req.usesTools, true);
    assert.deepStrictEqual(req.destinations, ['document_library', 'generated_files', 'knowledge_base', 'tables']);
    const none = await collectRequirements({ steps: [{ type: 'set' }] }, { providerForTool });
    assert.deepStrictEqual(none, { providers: [], httpConnections: [], usesTools: false, destinations: [] });
});

test('sessionHasProvider reads the starter\'s own session shapes', () => {
    assert.ok(sessionHasProvider(sessionWith(CALLER, ['google']), 'google'));
    assert.ok(!sessionHasProvider(sessionWith(CALLER, ['google']), 'microsoft'));
    assert.ok(sessionHasProvider({ oauthProvider: 'microsoft', accessToken: 't' }, 'microsoft'));
    assert.ok(sessionHasProvider({ connectorNcUid: 'u' }, 'nextcloud'));
    assert.ok(!sessionHasProvider(null, 'google'));
});

const ack = { items: ['app:google', 'app:microsoft', 'app:nextcloud', 'dest:generated_files'] };

function makeDeps({ sessions = {}, users, groups = ['g-c'], httpOk = true } = {}) {
    const calls = { updateRun: [], released: [], authorize: [] };
    const sessionRequests = [];
    const userRows = users || { [CALLER]: { id: CALLER, organizationId: ORG, orgRole: 'member' } };
    return {
        calls, sessionRequests,
        engine: { resolveUserSession: async (id) => { sessionRequests.push(id); return sessions[id] ?? null; } },
        loadUserStore: () => ({ getUser: async (id) => userRows[id] || null }),
        loadAudience: () => ({ resolveUserGroups: async () => groups }),
        loadConnectionResolution: () => ({ providerForTool }),
        loadConnectionStore: () => ({ authorizeConnectionUse: async (a) => { calls.authorize.push(a); return { ok: httpOk }; } }),
        clearRunCancellation: () => {},
        loadRunOutcome: () => ({ resolveRunOutcome: async () => ({}), storeOutcomeDeps: () => ({}) }),
        automationStore: {
            // The one-time notice: acknowledged for everything unless a test says otherwise.
            getCallerNoticeAck: async () => ack.items,
            updateRun: async (id, patch) => { calls.updateRun.push({ id, patch }); },
            updateAutomation: async () => {},
            releaseAutomation: async (id) => { calls.released.push(id); },
            getRun: async (id) => ({ id, status: 'error' }),
        },
    };
}
const FLOW = { steps: [{ type: 'integration_action', tool: 'gmail_search' }] };
const automation = { id: 'a1', userId: OWNER, definition: FLOW };
const gate = (deps, extra = {}) => applyCallerOnly(deps, {
    callerUserId: CALLER, automation, runOrgId: ORG, effectiveMode: 'live',
    failCtx: { run: { id: 'r1' }, heartbeatTimer: null, startedAt: Date.now(), automation, ownsMarker: true, emitLifecycle: () => {} },
    ...extra,
});
const failedWith = (deps) => deps.calls.updateRun[0]?.patch.errorClass;

test('caller with the connection: identity carries session, org, groups and role, loaded from the CALLER id only', async () => {
    const deps = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']), [OWNER]: sessionWith(OWNER, ['google']) } });
    const r = await gate(deps);
    assert.strictEqual(r.failedRow, null);
    assert.strictEqual(r.identity.userId, CALLER);
    assert.strictEqual(r.identity.orgId, ORG);
    assert.deepStrictEqual(r.identity.userGroupIds, ['g-c']);
    assert.strictEqual(r.identity.orgRole, 'member');
    assert.deepStrictEqual(deps.sessionRequests, [CALLER]);
});

test('caller WITHOUT the connection while the owner has it: fails before step 1 with "connect Google first", no fallback', async () => {
    const deps = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, []), [OWNER]: sessionWith(OWNER, ['google']) } });
    const r = await gate(deps);
    assert.strictEqual(r.identity, null);
    assert.ok(r.failedRow);
    const patch = deps.calls.updateRun[0].patch;
    assert.strictEqual(patch.status, 'error');
    assert.strictEqual(patch.errorClass, 'caller_not_connected');
    assert.match(patch.error, /Connect Google first/);
    assert.deepStrictEqual(deps.calls.released, ['a1']);
    assert.ok(!deps.sessionRequests.includes(OWNER), 'the owner\'s session is never consulted');
});

test('a null caller session fails closed when the flow uses tools, passes when it uses none', async () => {
    const deps = makeDeps({ sessions: {} });
    const r = await gate(deps);
    assert.strictEqual(r.identity, null);
    assert.strictEqual(failedWith(deps), 'caller_identity_unavailable');
    const pureDeps = makeDeps({ sessions: {} });
    const pure = await gate(pureDeps, { automation: { ...automation, definition: { steps: [{ type: 'set' }] } } });
    assert.strictEqual(pure.failedRow, null);
    assert.strictEqual(pure.identity.session, null);
});

test('the caller\'s organisation is read fresh and must be the run\'s, else fail closed', async () => {
    const other = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) }, users: { [CALLER]: { id: CALLER, organizationId: 'org-2' } } });
    assert.strictEqual((await gate(other)).identity, null);
    assert.strictEqual(failedWith(other), 'caller_identity_unavailable');
    const gone = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) }, users: {} });
    assert.strictEqual((await gate(gone)).identity, null);
    assert.strictEqual(failedWith(gone), 'caller_identity_unavailable');
});

test('an error while building the identity fails closed, never as the owner', async () => {
    const deps = makeDeps({});
    deps.engine.resolveUserSession = async () => { throw new Error('db down'); };
    const r = await gate(deps);
    assert.strictEqual(r.identity, null);
    assert.strictEqual(failedWith(deps), 'caller_identity_unavailable');
});

test('a saved HTTP credential is authorised for the CALLER (their id, org, groups); refused when they may not use it', async () => {
    const httpFlow = { id: 'a1', userId: OWNER, definition: { steps: [{ type: 'http_request', id: 'h1', auth: { connectionId: 'conn-1' } }] } };
    const ok = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, []) } });
    const r = await gate(ok, { automation: httpFlow });
    assert.strictEqual(r.failedRow, null);
    assert.deepStrictEqual(ok.calls.authorize, [{ connectionId: 'conn-1', runningUserId: CALLER, runningUserOrgId: ORG, runningUserGroups: ['g-c'] }]);
    const denied = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, []) }, httpOk: false });
    const d = await gate(denied, { automation: httpFlow });
    assert.strictEqual(d.identity, null);
    assert.strictEqual(failedWith(denied), 'caller_not_connected');
    assert.match(denied.calls.updateRun[0].patch.error, /not available to you/);
});

test('the one-time notice is enforced for the start itself: an unacknowledged person is told to open the automation once', async () => {
    const onCaller = { ...automation, definition: { ...FLOW, runPolicy: { connections: 'caller' } } };
    const deps = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) } });
    ack.items = null;
    const never = await gate(deps, { automation: onCaller });
    assert.strictEqual(never.identity, null);
    assert.strictEqual(failedWith(deps), 'caller_notice_required');
    assert.match(deps.calls.updateRun[0].patch.error, /Open this automation once and confirm/);
    // Acknowledged an older, smaller set: the notice shows again.
    const grown = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) } });
    ack.items = [];
    assert.strictEqual((await gate(grown, { automation: onCaller })).identity, null);
    assert.strictEqual(failedWith(grown), 'caller_notice_required');
    // Acknowledged the current set: it runs. A run that continues an earlier one needs no second notice.
    ack.items = ['app:google'];
    assert.ok((await gate(makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) } }), { automation: onCaller })).identity);
    ack.items = null;
    assert.ok((await gate(makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, ['google']) } }), { automation: onCaller, locked: true })).identity);
    ack.items = ['app:google', 'app:microsoft', 'app:nextcloud', 'dest:generated_files'];
});

test('a start that should name a person but does not is refused in caller mode', async () => {
    const deps = makeDeps({});
    const r = await gate(deps, { callerUserId: null, missingStarter: true });
    assert.strictEqual(r.identity, null);
    assert.ok(r.failedRow);
    assert.strictEqual(failedWith(deps), 'caller_identity_unavailable');
});

test('option off or owner run: nothing changes and no session is loaded', async () => {
    const deps = makeDeps({});
    const r = await gate(deps, { callerUserId: null });
    assert.deepStrictEqual(r, { identity: null, failedRow: null });
    assert.deepStrictEqual(deps.sessionRequests, []);
});

test('a dry run dispatches as the caller but is not refused for a missing connection', async () => {
    const deps = makeDeps({ sessions: { [CALLER]: sessionWith(CALLER, []) } });
    const r = await gate(deps, { effectiveMode: 'dry_run' });
    assert.strictEqual(r.failedRow, null);
    assert.strictEqual(r.identity.userId, CALLER);
});

test('CallerNotConnectedError names the provider', () => {
    const e = new CallerNotConnectedError('microsoft');
    assert.match(e.message, /Connect Microsoft first/);
    assert.strictEqual(e.provider, 'microsoft');
});

// ── Identity at the dispatch sites ──────────────────────────────────────────

const callerOnly = { userId: CALLER, session: sessionWith(CALLER, ['google']), orgId: ORG, userGroupIds: ['g-c'], orgRole: 'member', homeOrgId: ORG, isAdmin: true };
const ownerCtx = (extra = {}) => ({ userId: OWNER, orgId: ORG, session: { ...sessionWith(OWNER, ['google']), isAdmin: true }, userGroupIds: ['g-o'], automationId: 'a1', ...extra });

test('toolIdentity: owner by default, the caller\'s own (groups, org, role) when ctx.callerOnly is set', () => {
    assert.strictEqual(toolIdentity(ownerCtx()).userId, OWNER);
    assert.deepStrictEqual(toolIdentity(ownerCtx()).userGroupIds, ['g-o']);
    const c = toolIdentity(ownerCtx({ callerOnly }));
    assert.strictEqual(c.userId, CALLER);
    assert.strictEqual(c.orgId, ORG);
    assert.deepStrictEqual(c.userGroupIds, ['g-c']);
    assert.strictEqual(c.orgRole, 'member');
    assert.strictEqual(c.session, callerOnly.session);
});

test('toolIdentity: admin only when BOTH are admins', () => {
    assert.strictEqual(toolIdentity(ownerCtx({ callerOnly })).isAdmin, true);
    assert.strictEqual(toolIdentity(ownerCtx({ callerOnly: { ...callerOnly, isAdmin: false } })).isAdmin, false);
    const plainOwner = ownerCtx({ callerOnly });
    plainOwner.session = sessionWith(OWNER, ['google']);
    assert.strictEqual(toolIdentity(plainOwner).isAdmin, false, 'a caller admin on a non-admin owner\'s automation is not an admin');
});

test('lendPolicyFor: never lends on a caller-only run, even with a resource owner set', () => {
    assert.ok(lendPolicyFor(ownerCtx({ resourceOwnerUserId: 'x' })));
    assert.strictEqual(lendPolicyFor(ownerCtx({ resourceOwnerUserId: 'x', callerOnly })), null);
});

test('permittedCatalog: the owner\'s catalog for an owner run; owner ∩ caller for a caller run (neither side widens)', async () => {
    const byUser = { [OWNER]: ['a', 'b'], [CALLER]: ['b', 'c', 'admin_only'] };
    const asks = [];
    const get = async (o) => { asks.push(o); return { tools: byUser[o.userId].map(name => ({ function: { name } })), note: o.userId }; };
    const own = await permittedCatalog(ownerCtx(), get, { automationStep: true });
    assert.deepStrictEqual(own.tools.map(t => t.function.name), ['a', 'b']);
    assert.deepStrictEqual(asks.map(a => a.userId), [OWNER]);
    asks.length = 0;
    const both = await permittedCatalog(ownerCtx({ callerOnly }), get, { automationStep: true, lend: true });
    assert.deepStrictEqual(both.tools.map(t => t.function.name), ['b'], 'the caller\'s extra rights are not gained');
    assert.deepStrictEqual(asks.map(a => a.userId).sort(), [CALLER, OWNER].sort());
    assert.ok(asks.every(a => a.connectionPolicy === null && a.automationStep === true));
});

test('resolveLendingIdentity: owner run keeps the owner; caller-only dispatches as the caller and never asks the lending resolver', async () => {
    let resolverAsked = false;
    const deps = { connectionResolution: () => ({ isLendingEnabled: () => true, runningUserContext: async () => ({}), resolveEffectiveIdentity: async () => { resolverAsked = true; return { integrationUserId: OWNER, integrationOrgId: ORG }; } }) };
    const oc = ownerCtx();
    const own = await resolveLendingIdentity({ tool: 'gmail_search' }, oc, deps);
    assert.strictEqual(own.stepUserId, OWNER);
    assert.strictEqual(own.stepSession, oc.session);
    const c = await resolveLendingIdentity({ tool: 'gmail_search' }, ownerCtx({ resourceOwnerUserId: OWNER, callerOnly }), deps);
    assert.deepStrictEqual([c.stepUserId, c.stepOrgId, c.lentConnection], [CALLER, ORG, null]);
    assert.strictEqual(c.stepSession, callerOnly.session);
    assert.strictEqual(resolverAsked, false);
});

test('the permission gate runs on the intersection: a tool only the caller may use is refused', async () => {
    lookups.length = 0;
    const deps = { integrationTools: () => require('../integrations/integrationTools') };
    const ctx = ownerCtx({ callerOnly });
    await assertStepToolPermitted({ id: 's1', tool: 'gmail_search' }, ctx, false, deps);
    assert.deepStrictEqual(lookups.map(l => l.userId).sort(), [CALLER, OWNER].sort());
    assert.ok(lookups.every(l => l.connectionPolicy === null));
});
