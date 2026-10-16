/**
 * runPolicy.connections = 'caller', through executeAutomation: whose identity
 * reaches the integration step, the AI-step tool loop and the code-step bridge,
 * and what a run on the caller's connections refuses or hides.
 *
 * Run: node --test core/automationRunner.callerConnections.test.js
 */

'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert');
const { preloadStubs } = require('../testUtils/stubRequire');
const { installRunnerIdentityStubs } = require('../testUtils/runnerIdentityStubs');

/** A stub registered under the module's real resolved path (testUtils/stubRequire). */
const stubPath = (rel, exportsObj) => preloadStubs(require, { [rel]: exportsObj });
require('../automation/runnerPorts');
require('../integrations/runnerPorts');
require('../services/runnerPorts');

const OWNER = 'u-owner';
const CALLER = 'u-caller';
const NOCREDS = 'u-nocreds';
const ORG = 'org-1';

const USERS = {
    [OWNER]: { id: OWNER, organizationId: ORG, orgRole: 'admin', isAdmin: true, role: 'admin' },
    [CALLER]: { id: CALLER, organizationId: ORG, orgRole: 'member', isAdmin: false, role: 'user' },
    [NOCREDS]: { id: NOCREDS, organizationId: ORG, orgRole: 'member' },
    'u-nogoogle': { id: 'u-nogoogle', organizationId: ORG, orgRole: 'member' },
    'u-other-org': { id: 'u-other-org', organizationId: 'org-2' },
};
const GROUPS = { [OWNER]: ['g-owner'], [CALLER]: ['g-caller'], [NOCREDS]: [] };
const CONNECTED = new Set([OWNER, CALLER]);

installRunnerIdentityStubs({
    groups: GROUPS,
    providers: () => ['google'],
    session(userId) {
        if (userId === 'u-nogoogle') return { userId, accessToken: null, refreshToken: null, oauthProvider: null, automationProviders: {} };
        if (!CONNECTED.has(userId)) return null;
        return {
            userId, oauthProvider: 'google', accessToken: `tok-${userId}`, refreshToken: null, expiresAt: null,
            automationProviders: { google: { accessToken: `tok-${userId}` } },
        };
    },
});

const dispatches = [];
const catalogAsks = [];
let lastCtx = null;
let catalogFor = () => ['gmail_search'];

stubPath('./automationRunner/safety', {
    async resolveAutomationPolicy(ctx) { lastCtx = ctx; return { action: 'off', privacyScope: 'external' }; },
    buildAuditBase() { return {}; },
    async guardToolInput(inputs) { return { value: inputs, categories: [], wouldBlock: false }; },
    async guardToolOutput(result) { return { result, categories: [] }; },
    prepareForEgress(v) { return v; },
    restoreForRunState(v) { return v; },
    buildPiiSummary() { return null; },
    egressMode() { return 'real'; },
    async logEgress() {},
    async scanPayload() { return null; },
});
stubPath('./tools/toolDispatcher', {
    async executeTool(tool, inputs, opts) { dispatches.push({ tool, opts }); return { ok: true }; },
});
stubPath('./integrations/integrationTools', {
    async getIntegrationTools(opts) {
        catalogAsks.push(opts);
        return { tools: catalogFor(opts.userId).map(name => ({ function: { name } })) };
    },
});
stubPath('./integrations/integrationToolMap', {
    resolveIntegration: () => ({ isLocal: false, server: 'mail.example', integration: 'gmail', label: 'Gmail' }),
});
stubPath('./integrations/connectionResolution', {
    isLendingEnabled: () => false,
    providerForTool: (t) => (t.startsWith('gmail_') ? 'google' : null),
    async runningUserContext() { return { orgId: ORG, groups: [] }; },
    async resolveEffectiveIdentity() { return null; },
});

const { installPartialRunHarness } = require('./automationRunner.partial.testkit');
const { runner, storeStub, runs, reset } = installPartialRunHarness();
const userStore = require('../stores/userStore');
userStore.getUser = async (id) => USERS[id] || null;

const { registerRunnerPorts } = require('./automationRunner/featurePorts');
let sandboxCalls = [];
registerRunnerPorts({
    outputSchemas: { synthesizeDryRunOutput: () => ({ sample: true }) },
    codeSandbox: {
        isAvailable: () => true,
        loadError: () => '',
        async runCode({ bridges }) {
            sandboxCalls.push(await bridges.executeTool('gmail_search', { q: 'x' }));
            return { result: { ok: true }, logs: [], http: { calls: [] }, calls: [] };
        },
        defaultFetchHttp: async () => ({}),
    },
});
after(() => { setImmediate(() => process.exit(process.exitCode || 0)); });

// The store stub drops what createRun was given; keep the two fields under test.
const baseCreate = storeStub.createRun;
storeStub.createRun = async (args) => {
    const row = await baseCreate(args);
    row.startedByUserId = args.startedByUserId || null;
    row.connectionsMode = args.connectionsMode || null;
    return row;
};

// The one-time notice: acknowledged for Google unless a test says otherwise.
let ackItems = ['app:google'];
storeStub.getCallerNoticeAck = async () => ackItems;

// The harness keeps only some step fields: also keep which identity a step ran as.
const identityRows = [];
const baseRecord = storeStub.recordRunStep;
storeStub.recordRunStep = async (rec) => {
    if (rec.identityUserId) identityRows.push({ stepId: rec.stepId, identityUserId: rec.identityUserId });
    return baseRecord(rec);
};

function flow(connections, extraSteps = []) {
    return {
        id: 'auto-1', version: 1, userId: OWNER, organizationId: null, title: 'Caller flow',
        triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps: [{ id: 'mail', type: 'integration_action', tool: 'gmail_search', inputs: { q: 'invoice' } }, ...extraSteps],
            edges: [{ from: 'trig', to: 'mail' }, ...extraSteps.map((s, i) => ({ from: i === 0 ? 'mail' : extraSteps[i - 1].id, to: s.id }))],
            ...(connections ? { runPolicy: { connections } } : {}),
        },
    };
}

function resetAll() { reset(); ackItems = ['app:google']; identityRows.length = 0; dispatches.length = 0; catalogAsks.length = 0; sandboxCalls = []; lastCtx = null; catalogFor = () => ['gmail_search']; }
const run = (automation, opts) => runner.executeAutomation(automation, { triggerKind: 'manual', mode: 'live', ...opts });

test('owner run: the owner\'s session and org reach the integration step (nothing changes)', async () => {
    resetAll();
    const row = await run(flow('caller'), { startedByUserId: OWNER });
    assert.strictEqual(row.status, 'success', row.error);
    assert.strictEqual(row.connectionsMode, null);
    assert.strictEqual(dispatches[0].opts.userId, OWNER);
    assert.strictEqual(dispatches[0].opts.session.automationProviders.google.accessToken, `tok-${OWNER}`);
    assert.deepStrictEqual(dispatches[0].opts.userGroupIds, ['g-owner']);
    assert.deepStrictEqual(identityRows.map(r => r.identityUserId), [OWNER]);
});

test('shared user, option off: still the owner\'s identity (today\'s behaviour)', async () => {
    resetAll();
    const row = await run(flow(null), { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'success', row.error);
    assert.strictEqual(row.connectionsMode, null);
    assert.strictEqual(dispatches[0].opts.userId, OWNER);
    assert.strictEqual(dispatches[0].opts.session.automationProviders.google.accessToken, `tok-${OWNER}`);
});

test('shared user, option on: the CALLER\'s session, org and groups reach the integration step', async () => {
    resetAll();
    const row = await run(flow('caller'), { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'success', row.error);
    assert.strictEqual(row.connectionsMode, 'caller');
    const d = dispatches[0].opts;
    assert.strictEqual(d.userId, CALLER);
    assert.strictEqual(d.orgId, ORG);
    assert.strictEqual(d.session.automationProviders.google.accessToken, `tok-${CALLER}`);
    assert.deepStrictEqual(d.userGroupIds, ['g-caller']);
    assert.strictEqual(d.connectionsCallerUserId, CALLER);
    // The permission catalog was asked for BOTH people, with no lending.
    assert.deepStrictEqual(catalogAsks.map(a => a.userId).sort(), [CALLER, OWNER].sort());
    assert.ok(catalogAsks.every(a => a.connectionPolicy === null));
    // Which identity the step used is recorded on its row (an id, nothing else).
    assert.deepStrictEqual(identityRows.map(r => [r.stepId, r.identityUserId]), [['mail', CALLER]]);
});

test('caller without a connection: the run fails before step 1, the owner\'s connection is never used', async () => {
    resetAll();
    const row = await run(flow('caller'), { startedByUserId: NOCREDS });
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.errorClass, 'caller_identity_unavailable');
    assert.strictEqual(dispatches.length, 0);
});

test('caller with a session but no Google connection while the owner has one: "Connect Google first", no fallback', async () => {
    resetAll();
    const row = await run(flow('caller'), { startedByUserId: 'u-nogoogle' });
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.errorClass, 'caller_not_connected');
    assert.match(row.error, /Connect Google first/);
    assert.strictEqual(dispatches.length, 0, 'the owner\'s Google connection is never used instead');
});

test('caller whose session is null but the flow only reads data steps: not refused', async () => {
    resetAll();
    const pure = { ...flow('caller'), definition: { trigger: { id: 'trig', type: 'trigger', kind: 'manual' }, steps: [{ id: 'A', type: 'set', fields: { v: { kind: 'literal', value: 1 } } }], edges: [{ from: 'trig', to: 'A' }], runPolicy: { connections: 'caller' } } };
    const row = await run(pure, { startedByUserId: NOCREDS });
    assert.strictEqual(row.status, 'success', row.error);
});

test('caller in another organisation than the run: fails closed', async () => {
    resetAll();
    CONNECTED.add('u-other-org');
    const row = await run(flow('caller'), { startedByUserId: 'u-other-org' });
    CONNECTED.delete('u-other-org');
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.errorClass, 'caller_identity_unavailable');
    assert.strictEqual(dispatches.length, 0);
});

test('an interactive trigger with no starter is refused in caller mode, allowed otherwise', async () => {
    resetAll();
    const refused = await run(flow('caller'), { triggerKind: 'studio_app', startedByUserId: null });
    assert.strictEqual(refused.status, 'error');
    assert.strictEqual(dispatches.length, 0);
    const ok = await run(flow(null), { triggerKind: 'studio_app', startedByUserId: null });
    assert.strictEqual(ok.status, 'success', ok.error);
    // ANY other start without a person is refused too: a caller that forgets fails closed.
    for (const triggerKind of ['manual', 'dry_run', 'skill', 'something_new']) {
        const r = await run(flow('caller'), { triggerKind, startedByUserId: null });
        assert.strictEqual(r.status, 'error', triggerKind);
    }
    const schedule = await run(flow('caller'), { triggerKind: 'schedule', startedByUserId: null });
    assert.strictEqual(schedule.status, 'success', schedule.error);
});

test('the one-time notice is enforced centrally: a start with a person (a skill, an agent, an app) fails until they confirmed, then runs', async () => {
    resetAll();
    ackItems = null;
    const refused = await run(flow('caller'), { triggerKind: 'agent_call', startedByUserId: CALLER });
    assert.strictEqual(refused.status, 'error');
    assert.strictEqual(refused.errorClass, 'caller_notice_required');
    assert.match(refused.error, /Open this automation once/);
    assert.strictEqual(dispatches.length, 0);
    ackItems = ['app:google'];
    const ok = await run(flow('caller'), { triggerKind: 'agent_call', startedByUserId: CALLER });
    assert.strictEqual(ok.status, 'success', ok.error);
    // A destination added later brings the notice back.
    const grown = flow('caller');
    grown.definition.steps.push({ id: 'kb', type: 'knowledge_write' });
    grown.definition.edges.push({ from: 'mail', to: 'kb' });
    dispatches.length = 0;
    const again = await run(grown, { triggerKind: 'agent_call', startedByUserId: CALLER });
    assert.strictEqual(again.errorClass, 'caller_notice_required');
    assert.strictEqual(dispatches.length, 0);
});

test('a code step\'s bridge dispatches as the caller, with the caller\'s groups', async () => {
    resetAll();
    const code = { id: 'code', type: 'code', code: 'return 1', allowedTools: ['gmail_search'], inputs: {} };
    const row = await run(flow('caller', [code]), { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'success', row.error);
    const bridged = dispatches.find(d => d.tool === 'gmail_search' && d.opts.runScope && d.opts.egress === false);
    assert.ok(bridged, 'the sandbox bridge dispatched');
    assert.strictEqual(bridged.opts.userId, CALLER);
    assert.strictEqual(bridged.opts.session.automationProviders.google.accessToken, `tok-${CALLER}`);
    assert.deepStrictEqual(bridged.opts.userGroupIds, ['g-caller']);
});

test('an AI step\'s tool dispatch uses the caller\'s identity from the same run context', async () => {
    resetAll();
    const row = await run(flow('caller'), { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'success', row.error);
    assert.ok(lastCtx && lastCtx.callerOnly, 'the run context carries the caller identity');
    const { dispatchAiToolCall } = require('./automationRunner/aiStepToolLoop');
    dispatches.length = 0;
    await dispatchAiToolCall(
        { function: { name: 'gmail_search', arguments: '{}' } }, { q: 'x' }, {},
        { ctx: lastCtx, mode: 'live', policy: {}, agentBinding: null, executeTool: require('./tools/toolDispatcher').executeTool },
    );
    assert.strictEqual(dispatches[0].opts.userId, CALLER);
    assert.strictEqual(dispatches[0].opts.orgId, ORG);
    assert.deepStrictEqual(dispatches[0].opts.userGroupIds, ['g-caller']);
    assert.strictEqual(dispatches[0].opts.session.automationProviders.google.accessToken, `tok-${CALLER}`);
});

test('WIDENING: a caller with more rights than the owner gains nothing', async () => {
    resetAll();
    // The owner may only search; the caller could do more. The run offers/permits the intersection.
    catalogFor = (userId) => (userId === OWNER ? ['gmail_search'] : ['gmail_search', 'gmail_send', 'drive_delete']);
    const sendFlow = flow('caller');
    sendFlow.definition.steps.push({ id: 'send', type: 'integration_action', tool: 'gmail_send', inputs: {} });
    sendFlow.definition.edges.push({ from: 'mail', to: 'send' });
    const row = await run(sendFlow, { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'error', 'gmail_send is outside the owner\'s catalog, so the caller may not run it either');
    assert.ok(!dispatches.some(d => d.tool === 'gmail_send'));
    assert.ok(dispatches.some(d => d.tool === 'gmail_search'));
});

test('WIDENING the other way: the owner has more, the caller only gets its own', async () => {
    resetAll();
    catalogFor = (userId) => (userId === CALLER ? ['gmail_search'] : ['gmail_search', 'gmail_send']);
    const sendFlow = flow('caller');
    sendFlow.definition.steps.push({ id: 'send', type: 'integration_action', tool: 'gmail_send', inputs: {} });
    sendFlow.definition.edges.push({ from: 'mail', to: 'send' });
    const row = await run(sendFlow, { startedByUserId: CALLER });
    assert.strictEqual(row.status, 'error');
    assert.ok(!dispatches.some(d => d.tool === 'gmail_send'));
});

test('a resumed run keeps the caller mode even when the setting was switched off meanwhile', async () => {
    resetAll();
    const row = await run(flow(null), { startedByUserId: CALLER, lockedConnectionsMode: 'caller' });
    assert.strictEqual(row.status, 'success', row.error);
    assert.strictEqual(row.connectionsMode, 'caller');
    assert.strictEqual(dispatches[0].opts.userId, CALLER);
    assert.ok(runs.size >= 1);
});

test('RESUME: a paused caller-mode run continues as the caller even if the setting was switched off meanwhile', async () => {
    resetAll();
    // The paused run, as the store holds it: started by the caller under the caller policy.
    const paused = await storeStub.createRun({
        automationId: 'auto-1', version: 1, userId: OWNER, triggerKind: 'manual', mode: 'live',
        startedByUserId: CALLER, connectionsMode: 'caller',
    });
    Object.assign(paused, { status: 'awaiting_form', awaitingStepId: 'gate' });
    const stored = flow(null);   // the setting is OFF now
    stored.definition.steps = [
        { id: 'gate', type: 'set', fields: {} },
        { id: 'mail', type: 'integration_action', tool: 'gmail_search', inputs: { q: 'x' } },
    ];
    stored.definition.edges = [{ from: 'trig', to: 'gate' }, { from: 'gate', to: 'mail' }];
    storeStub.getAutomation = async () => stored;
    const child = await runner.resumeFromStep(paused.id, 'gate', { decision: { ok: true }, userId: OWNER });
    assert.strictEqual(child.status, 'success', child.error);
    assert.strictEqual(child.connectionsMode, 'caller');
    assert.strictEqual(dispatches[0].opts.userId, CALLER, 'the remaining steps still use the caller\'s connections');
    // And a paused run that began as an owner run stays one.
    dispatches.length = 0;
    const ownerPaused = await storeStub.createRun({
        automationId: 'auto-1', version: 1, userId: OWNER, triggerKind: 'manual', mode: 'live', startedByUserId: CALLER, connectionsMode: null,
    });
    Object.assign(ownerPaused, { status: 'awaiting_form', awaitingStepId: 'gate' });
    const child2 = await runner.resumeFromStep(ownerPaused.id, 'gate', { decision: { ok: true }, userId: OWNER });
    assert.strictEqual(child2.connectionsMode, null);
    assert.strictEqual(dispatches[0].opts.userId, OWNER);
});
