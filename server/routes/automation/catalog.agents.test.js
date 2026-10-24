'use strict';

/**
 * The agent side of the builder catalogue (R2, part C):
 *   GET /catalog                 → `agents` + `agentsError`
 *   GET /catalog/agent/:agentId  → what one agent brings along in this step
 *
 * Two properties that can ONLY be pinned HERE, because they sit in the route and not in the pure module next to it:
 *
 *   1. A FAILED READ IS NOT AN EMPTY LIST. Every other list in this catalogue (tables, knowledge bases) falls back to `[]` on a failure, and that is
 *      allowed there: "nothing connected yet" is a normal state. For agents it is not — an empty list would tell the author that his agents are gone.
 *      Hence `agentsError`, and the editor reads that first.
 *   2. A REFUSAL IS UNDIFFERENTIATED. The id comes in via the client's preview, so "does not exist", "other organisation" and "not shared"
 *      give exactly the same answer. The PICKER may name the reason (it shows only rows that the requester already sees anyway); this route may not.
 *
 * The same mock technique as routes/automation/catalog.test.js: the module cache
 * is filled before the router is loaded, and the handler is called directly with a fake req/res.
 *
 * Run: cd server && node --test --test-reporter=tap routes/automation/catalog.agents.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const SERVER = path.resolve(__dirname, '..', '..');
const { mockModule: mock } = require('../../testUtils/moduleMock');

// ── Per-test state ──────────────────────────────────────────────────
let MY_AGENTS = [];
let PUBLISHED_AGENTS = [];
let AGENT_STORE_THROWS = null;
let RUNTIME_AGENT = null;          // wat getForRuntime/resolveStepAgent oplevert
let GATE = { tools: [], withheld: [], degraded: false, catalogError: null };
let CONFIRM_BY_NAME = {};

// ── The rest of the catalogue: silent, so that only the agent branch speaks ──
let PRINCIPAL_ORG = 'org1';
let PRINCIPAL_ERROR = null;
let LAST_GATE_ARGS = null;
mock(path.join(SERVER, 'stores/automationStore'), { getCallableStepsForUser: async () => [] });
mock(path.join(SERVER, 'stores/configStore'), { getConfig: async () => null });
mock(path.join(SERVER, 'automation/toolRegistry'), { TOOL_REGISTRY: [], loadTools: () => [] });
mock(path.join(SERVER, 'automation/sideEffectMap'), { isSideEffect: () => false, effectOf: () => 'reads' });
mock(path.join(SERVER, 'automation/outputSchemas'), {
    getOutputSchema: () => null, synthesizeDryRunOutput: () => ({}),
    producesList: () => false, iterableFieldsOf: () => [],
});
mock(path.join(SERVER, 'core/integrations/integrationToolMap'), { resolveIntegration: () => null });
mock(path.join(SERVER, 'core/integrations/integrationTools'), {
    getIntegrationTools: async () => ({ tools: [] }),
    availableMcpServerIds: async () => new Set(),
});
mock(path.join(SERVER, 'core/entitlements/betaFeatures'), { userHasBetaFeature: async () => false });
mock(path.join(SERVER, 'stores/supportInboxStore'), { listInboxes: async () => [] });
mock(path.join(SERVER, 'automation/triggerBus'), { getPublicBaseUrl: () => null });
mock(path.join(SERVER, 'automation/builderTools'), {
    buildTriggerOutputsCatalog: require(path.join(SERVER, 'automation/builderTools/triggerCatalog')).buildTriggerOutputsCatalog,
});
mock(path.join(SERVER, 'stores/datatableStore'), {
    listDatatablesForScope: async () => [], getModel: async () => ({ model: { tables: [] } }),
    listGrantsForTables: async () => new Map(),
});
mock(path.join(SERVER, 'stores/knowledgeBases'), {
    listKBs: async () => [], filterByGroupAccess: () => [],
    canUserManageKB: () => false, isSystemKB: () => false,
});
mock(path.join(SERVER, 'auth'), {
    resolveUserOrgIds: async () => new Set(['org1']),
    hasPermission: async () => false,
    resolveUserGroups: async () => [],
});

// ── De modules waar de agent-tak echt op leunt ──────────────────────
mock(path.join(SERVER, 'auth/audience'), {
    resolveAudienceContext: async () => ({ orgIds: [], userGroups: [] }),
    resolveUserGroups: async () => ['g1'],
});
mock(path.join(SERVER, 'auth/datatableAccess'), {
    // `organizationId` is the HOME org from the user row — the same column that
    // the save check and the run read. `identityError` is non-null as soon as that
    // read failed, and that is a fault, not a policy.
    resolveDatatablePrincipal: async () => ({ orgId: 'org1', organizationId: PRINCIPAL_ORG, identityError: PRINCIPAL_ERROR }),
    datatableScopesFor: () => [],
    gradeForPrincipal: () => null,
    gradeAtLeast: () => false,
});
mock(path.join(SERVER, 'stores/agentStore'), {
    getAgents: async () => {
        if (AGENT_STORE_THROWS) throw new Error(AGENT_STORE_THROWS);
        return MY_AGENTS;
    },
    getPublishedAgentsForUser: async () => {
        if (AGENT_STORE_THROWS) throw new Error(AGENT_STORE_THROWS);
        return PUBLISHED_AGENTS;
    },
});
mock(path.join(SERVER, 'core/automationRunner/aiStepAgent'), {
    resolveStepAgent: async (step) => {
        if (!RUNTIME_AGENT) {
            const e = new Error('nope');
            e.errorClass = 'agent_forbidden';
            throw e;
        }
        return { ...RUNTIME_AGENT, permissions: step.agentPermissions };
    },
    agentToolsForStep: async (args) => { LAST_GATE_ARGS = args; return GATE; },
});
mock(path.join(SERVER, 'core/agentRuntime/toolPolicy'), {
    toolsConfigOf: (config) => (config && config.tools) || null,
    confirmForTool: (name) => CONFIRM_BY_NAME[name] || 'direct',
});

const router = require('./catalog');

function findHandler(method, routePath) {
    for (const layer of router.stack) {
        if (layer.route && layer.route.path === routePath && layer.route.methods[method]) {
            return layer.route.stack[layer.route.stack.length - 1].handle;
        }
    }
    throw new Error(`route not found: ${method} ${routePath}`);
}
const catalogHandler = findHandler('get', '/catalog');
const agentHandler = findHandler('get', '/catalog/agent/:agentId');

function makeRes() {
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}
const REQ = { session: { user: { id: 'u1', organizationId: 'org1' }, isAdmin: false } };

function reset() {
    MY_AGENTS = [];
    PUBLISHED_AGENTS = [];
    AGENT_STORE_THROWS = null;
    RUNTIME_AGENT = null;
    GATE = { tools: [], withheld: [], reasons: {}, degraded: false, catalogError: null };
    CONFIRM_BY_NAME = {};
    PRINCIPAL_ORG = 'org1';
    PRINCIPAL_ERROR = null;
    LAST_GATE_ARGS = null;
}

// `published_version` belongs here: shared (`is_published`) and "serves a published
// config" are two switches, and only the second determines what runs. `getPublishedAgentsForUser` returns the rows through `projectRuntime`,
// so in production such a row carries `runtimeSource`; `getAgents` returns the bare row with the column.
const agent = (over = {}) => ({
    id: 'agt_1', name: 'Sales bot', description: null, owner_id: 'u2',
    organization_id: 'org1', is_published: true, published_version: 2, runtimeSource: 'published',
    shared_groups: [], ...over,
});

async function getCatalog() {
    const res = makeRes();
    await catalogHandler(REQ, res);
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    return res.body;
}

async function getAgentPreview(id, query = {}) {
    const res = makeRes();
    await agentHandler({ ...REQ, params: { agentId: id }, query }, res);
    return res;
}

// ── GET /catalog ────────────────────────────────────────────────────

test('de catalogus draagt de agents die deze auteur kan zien, met hun reden', async () => {
    reset();
    MY_AGENTS = [agent({ id: 'agt_mine', name: 'Mine', owner_id: 'u1', is_published: false })];
    PUBLISHED_AGENTS = [
        agent({ id: 'agt_ok', name: 'Shared' }),
        agent({ id: 'agt_far', name: 'Far', organization_id: 'org2' }),
    ];
    const body = await getCatalog();
    assert.strictEqual(body.agentsError, null);
    const byId = Object.fromEntries(body.agents.map(a => [a.id, a]));
    // Mijn eigen concept mag ik zelf inzetten.
    assert.strictEqual(byId.agt_mine.canUse, true);
    assert.strictEqual(byId.agt_ok.canUse, true);
    // Die van een andere organisatie staat er WEL, met de reden.
    assert.strictEqual(byId.agt_far.canUse, false);
    assert.strictEqual(byId.agt_far.reason, 'other_org');
});

test('een mislukte lezing levert agentsError, niet stilzwijgend een lege lijst', async () => {
    reset();
    AGENT_STORE_THROWS = 'agents table is on fire';
    const body = await getCatalog();
    assert.deepStrictEqual(body.agents, []);
    assert.ok(body.agentsError, 'zonder deze sleutel leest een lege lijst als "u heeft geen agents"');
    assert.match(body.agentsError, /on fire/);
    // En de rest van de catalogus blijft gewoon staan.
    assert.ok(Array.isArray(body.apps));
    assert.ok(Array.isArray(body.triggers));
});

// ── GET /catalog/agent/:agentId ─────────────────────────────────────

test('de preview noemt welke tools worden weggehouden omdat ze bevestiging vragen', async () => {
    reset();
    RUNTIME_AGENT = { agent: { name: 'Sales bot' }, agentId: 'agt_1', config: { tools: { gmail: {} } }, runtimeSource: 'published' };
    GATE = {
        tools: [{ function: { name: 'gmail_search' } }],
        withheld: ['gmail_compose', 'drive_delete'],
        // The reason comes from the gate that REMOVES the tool, not from a second
        // reading here. Re-judging with `confirmForTool` gave every sending tool 'confirm', also when it
        // failed on a switch that was off — and then the screen advises an approval step that
        // changes nothing.
        reasons: { gmail_compose: 'confirm', drive_delete: 'unavailable' },
        degraded: false, catalogError: null,
    };
    CONFIRM_BY_NAME = { gmail_compose: 'direct', drive_delete: 'ask' };   // bewust ANDERSOM

    const res = await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.canUse, true);
    assert.deepStrictEqual(res.body.allowed, ['gmail_search']);
    assert.deepStrictEqual(res.body.withheld, [
        { name: 'gmail_compose', reason: 'confirm' },   // een mens zou moeten goedkeuren
        { name: 'drive_delete', reason: 'unavailable' }, // om een andere reden weg
    ]);
    assert.strictEqual(res.body.runtimeSource, 'published');
    assert.deepStrictEqual(res.body.permissions, { startAutomations: false, useKnowledge: false, useTools: true });
});

test('dezelfde naam twee keer weggehouden levert één regel', async () => {
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'live' };
    GATE = { tools: [], withheld: ['gmail_compose', 'gmail_compose', null, ''], reasons: { gmail_compose: 'confirm' }, degraded: false, catalogError: null };
    const res = await getAgentPreview('agt_1', { useTools: '1' });
    assert.deepStrictEqual(res.body.withheld, [{ name: 'gmail_compose', reason: 'confirm' }]);
});

test('een agent die deze automatisering niet mag gebruiken krijgt één ongedifferentieerd antwoord', async () => {
    reset();
    RUNTIME_AGENT = null;      // resolveStepAgent gooit
    const res = await getAgentPreview('agt_someone_elses', { useTools: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.canUse, false);
    assert.deepStrictEqual(res.body.withheld, []);
    assert.deepStrictEqual(res.body.allowed, []);
    // NO reason, no name, no errorClass: the requester must not be able to
    // tell from this whether this id exists somewhere else.
    assert.strictEqual(res.body.reason, undefined);
    assert.strictEqual(res.body.name, undefined);
    assert.strictEqual(JSON.stringify(res.body).includes('forbidden'), false);
});

test('de schakelaars van de stap gaan mee — de preview beschrijft DEZE stap', async () => {
    reset();
    let seen = null;
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    // Een tweede mock op dezelfde module: de handler leest hem per aanroep.
    require.cache[require.resolve(path.join(SERVER, 'core/automationRunner/aiStepAgent'))].exports.resolveStepAgent =
        async (step) => { seen = step.agentPermissions; return { ...RUNTIME_AGENT, permissions: step.agentPermissions }; };

    await getAgentPreview('agt_1', { useTools: '1', startAutomations: 'true' });
    assert.deepStrictEqual(seen, { startAutomations: true, useKnowledge: false, useTools: true });

    await getAgentPreview('agt_1', {});
    assert.deepStrictEqual(seen, { startAutomations: false, useKnowledge: false, useTools: false },
        'ontbrekende parameters zijn NEE, nooit ja');
});

test('een degraded registry en een catalogusfout komen mee terug in plaats van als "geen tools"', async () => {
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    GATE = { tools: [], withheld: [], degraded: true, catalogError: 'registry down' };
    const res = await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(res.body.degraded, true);
    assert.strictEqual(res.body.error, 'registry down');
});

test('een tool die op een SCHAKELAAR sneuvelde krijgt niet het bevestigingsadvies', async () => {
    // `permission` and `confirm` are two sentences with two different actions. In the state "startAutomations on, useTools off" the
    // catalogue IS built and every non-automation tool falls on the switch —
    // after which "add an approval step behind it" is advice that cannot work.
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    GATE = { tools: [], withheld: ['gmail_compose'], reasons: { gmail_compose: 'permission' }, degraded: false, catalogError: null };
    CONFIRM_BY_NAME = { gmail_compose: 'ask' };
    const res = await getAgentPreview('agt_1', { startAutomations: '1' });
    assert.deepStrictEqual(res.body.withheld, [{ name: 'gmail_compose', reason: 'permission' }]);
});

test('de expliciete toollijst van de STAP gaat mee, zodat de capsule telt wat de run biedt', async () => {
    // `step.tools` is an allowlist and `[]` means ZERO tools (execAi reads an
    // explicit array that way). Without this parameter the preview counted the whole agent
    // catalogue and promised tools that the step never gets.
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    await getAgentPreview('agt_1', { useTools: '1', tools: 'gmail_search, drive_search' });
    assert.deepStrictEqual(LAST_GATE_ARGS.allowList, ['gmail_search', 'drive_search']);

    // Absent is something different from empty: no list = the author has set none,
    // and then nothing is narrowed.
    await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(LAST_GATE_ARGS.allowList, null);
});

test('een identiteitslezing die faalde is geen agent van een andere organisatie', async () => {
    // With `orgId` null because the user row could not be read, EVERY
    // shared org agent got `reason: 'other_org'` ("Belongs to another
    // workspace") and the author would drop a perfectly good agent from his automation on the grounds of a database hiccup. `agentsError` exists for exactly that case.
    reset();
    PRINCIPAL_ERROR = 'the user row could not be read';
    MY_AGENTS = [agent({ id: 'agt_mine', owner_id: 'u1' })];
    PUBLISHED_AGENTS = [agent({ id: 'agt_ok' })];
    const body = await getCatalog();
    assert.deepStrictEqual(body.agents, []);
    assert.ok(body.agentsError, 'een storing hoort in agentsError, niet in vier keer "andere workspace"');
    assert.match(body.agentsError, /identity unavailable/);
});

test('de preview weigert te antwoorden als de identiteit niet gelezen kon worden', async () => {
    // `canUse: false` would here advise "publish and share it" for an agent
    // where nothing is wrong. On a not-ok answer the capsule draws its own
    // "could not check" sentence.
    reset();
    PRINCIPAL_ERROR = 'the user row could not be read';
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    // The refusal is an HttpError for the terminal handler, never a policy answer.
    await assert.rejects(getAgentPreview('agt_1', { useTools: '1' }), (err) => {
        assert.strictEqual(err.status, 503);
        assert.strictEqual(err.code, 'identity_unavailable');
        assert.match(err.message, /identity unavailable/);
        return true;
    });
});

test('de HOME-org beslist, niet de groepsafgeleide terugval', async () => {
    // `principal.orgId` carries a group-derived fallback that the save check and
    // the run do not have. Giving one of the three readers an extra fallback is
    // a row that looks right here and fails at 03:00.
    reset();
    PRINCIPAL_ORG = null;                       // geen home-org
    PUBLISHED_AGENTS = [agent({ id: 'agt_ok', organization_id: 'org1' })];
    const body = await getCatalog();
    assert.strictEqual(body.agents.length, 1);
    assert.strictEqual(body.agents[0].canUse, false);
    assert.strictEqual(body.agents[0].reason, 'other_org');
});

test('gedeeld zonder ooit een VERSIE te publiceren is niet kiesbaar, met de juiste raad', async () => {
    // The publish switch is on, but `getForRuntime` still serves the owner's live draft. An unguarded automation of someone else
    // may not run on that; the sentence the picker shows is "publish it", and that is exactly the action that resolves it.
    reset();
    PUBLISHED_AGENTS = [agent({ id: 'agt_draftish', published_version: 0, runtimeSource: 'live' })];
    const body = await getCatalog();
    assert.strictEqual(body.agents[0].canUse, false);
    assert.strictEqual(body.agents[0].reason, 'not_published');
});

// ── Handoff 5: what the step editor draws beside the names ───────────

test('the preview also carries version, scope and the tools grouped per integration', async () => {
    reset();
    RUNTIME_AGENT = {
        agent: { name: 'Quote bot', is_published: true, organization_id: 'org1', published_version: 3 },
        agentId: 'agt_1', config: {}, runtimeSource: 'published',
    };
    GATE = {
        tools: [{ function: { name: 'gmail_search' } }],
        withheld: ['automation_r1'],
        reasons: { automation_r1: 'permission' },
        toolDefs: [{ function: { name: 'automation_r1' }, __automation: { id: 'r1' } }],
        degraded: false, catalogError: null,
    };
    const res = await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.version, 3);
    assert.strictEqual(res.body.scope, 'org');
    assert.deepStrictEqual(res.body.knowledgeBases, []);
    assert.deepStrictEqual(res.body.skills, []);
    const automations = res.body.tools.find((g) => g.integration === 'automations');
    assert.deepStrictEqual(automations, {
        integration: 'automations', label: 'Automations', tools: ['automation_r1'],
        withheld: true, reason: 'permission', withheldTools: [{ name: 'automation_r1', reason: 'permission' }],
    });
    assert.ok(res.body.tools.some((g) => g.tools.includes('gmail_search') && g.withheld === false));
});
