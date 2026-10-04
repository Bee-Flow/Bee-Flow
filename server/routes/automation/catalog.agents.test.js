'use strict';

/**
 * De agent-kant van de builder-catalogus (R2, deel C):
 *   GET /catalog                 → `agents` + `agentsError`
 *   GET /catalog/agent/:agentId  → wat één agent in deze stap meebrengt
 *
 * Twee eigenschappen die alleen HIER kunnen worden vastgelegd, want ze zitten
 * in de route en niet in de pure module ernaast:
 *
 *   1. EEN MISLUKTE LEZING IS GEEN LEGE LIJST. Elke andere lijst in deze
 *      catalogus (tabellen, kennisbanken) valt bij een storing terug op `[]`,
 *      en dat mag daar: "nog niets gekoppeld" is een normale toestand. Bij
 *      agents niet — een lege lijst zou de auteur vertellen dat zijn agents weg
 *      zijn. Daarom `agentsError`, en de editor leest die eerst.
 *   2. EEN WEIGERING IS ONGEDIFFERENTIEERD. Het id komt bij de preview van de
 *      client, dus "bestaat niet", "andere organisatie" en "niet gedeeld"
 *      geven exact hetzelfde antwoord. De KIEZER mag de reden wel noemen (die
 *      toont alleen rijen die de vrager toch al ziet); deze route niet.
 *
 * Zelfde mocktechniek als routes/automation/catalog.test.js: de module-cache
 * wordt gevuld vóór de router wordt geladen, en de handler wordt rechtstreeks
 * aangeroepen met een nep-req/res.
 *
 * Draaien: cd server && node --test --test-reporter=tap routes/automation/catalog.agents.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

const SERVER = path.resolve(__dirname, '..', '..');
function mock(absId, exports) {
    const p = require.resolve(absId);
    const m = new Module(p);
    m.exports = exports;
    m.loaded = true;
    require.cache[p] = m;
}

// ── Per-test state ──────────────────────────────────────────────────
let MY_AGENTS = [];
let PUBLISHED_AGENTS = [];
let AGENT_STORE_THROWS = null;
let RUNTIME_AGENT = null;          // wat getForRuntime/resolveStepAgent oplevert
let GATE = { tools: [], withheld: [], degraded: false, catalogError: null };
let CONFIRM_BY_NAME = {};

// ── De rest van de catalogus: stil, zodat alleen de agent-tak spreekt ──
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
    // `organizationId` is de HOME-org uit de gebruikersrij — dezelfde kolom die
    // de save-check en de run lezen. `identityError` is niet-null zodra die
    // lezing niet lukte, en dat is een storing, geen beleid.
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

// `published_version` hoort erbij: gedeeld (`is_published`) en "serveert een
// gepubliceerde config" zijn twee schakelaars, en alleen de tweede bepaalt wat
// er draait. `getPublishedAgentsForUser` levert de rijen door `projectRuntime`
// heen, dus in productie draagt zo'n rij `runtimeSource`; `getAgents` levert de
// kale rij met de kolom.
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
        // De reden komt van de poort die de tool WEGNAM, niet van een tweede
        // lezing hier. Opnieuw beoordelen met `confirmForTool` gaf elke
        // verzendende tool 'confirm', ook als hij op een uitgezette schakelaar
        // sneuvelde — en dan adviseert het scherm een goedkeuringsstap die
        // niets verandert.
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
    // GEEN reden, geen naam, geen errorClass: de vrager mag hieraan niet
    // kunnen aflezen of dit id ergens anders bestaat.
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
    // `permission` en `confirm` zijn twee zinnen met twee verschillende
    // handelingen. In de stand "startAutomations aan, useTools uit" wordt de
    // catalogus wél gebouwd en valt elke niet-automation-tool op de schakelaar —
    // waarna "zet er een goedkeuringsstap achter" advies is dat niet kan werken.
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    GATE = { tools: [], withheld: ['gmail_compose'], reasons: { gmail_compose: 'permission' }, degraded: false, catalogError: null };
    CONFIRM_BY_NAME = { gmail_compose: 'ask' };
    const res = await getAgentPreview('agt_1', { startAutomations: '1' });
    assert.deepStrictEqual(res.body.withheld, [{ name: 'gmail_compose', reason: 'permission' }]);
});

test('de expliciete toollijst van de STAP gaat mee, zodat de capsule telt wat de run biedt', async () => {
    // `step.tools` is een allowlist en `[]` betekent NUL tools (execAi leest een
    // expliciete array zo). Zonder deze parameter telde de preview de hele
    // agentcatalogus en beloofde tools die de stap nooit krijgt.
    reset();
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    await getAgentPreview('agt_1', { useTools: '1', tools: 'gmail_search, drive_search' });
    assert.deepStrictEqual(LAST_GATE_ARGS.allowList, ['gmail_search', 'drive_search']);

    // Afwezig is iets anders dan leeg: geen lijst = de auteur heeft er geen
    // gezet, en dan versmalt er niets.
    await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(LAST_GATE_ARGS.allowList, null);
});

test('een identiteitslezing die faalde is geen agent van een andere organisatie', async () => {
    // Met `orgId` null omdat de gebruikersrij niet te lezen was, kreeg élke
    // gedeelde org-agent `reason: 'other_org'` ("Belongs to another
    // workspace") en haalde de auteur een prima agent uit zijn automatisering op grond
    // van een databasehik. `agentsError` bestaat precies voor die zin.
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
    // `canUse: false` zou hier "publiceer en deel hem" adviseren voor een agent
    // waar niets mis mee is. De capsule tekent op een niet-ok antwoord haar
    // eigen "kon niet nakijken"-zin.
    reset();
    PRINCIPAL_ERROR = 'the user row could not be read';
    RUNTIME_AGENT = { agent: { name: 'A' }, agentId: 'agt_1', config: {}, runtimeSource: 'published' };
    const res = await getAgentPreview('agt_1', { useTools: '1' });
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.canUse, undefined, 'geen beleidsantwoord op een storing');
    assert.match(res.body.error, /identity unavailable/);
});

test('de HOME-org beslist, niet de groepsafgeleide terugval', async () => {
    // `principal.orgId` draagt een groepsafgeleide terugval die de save-check en
    // de run niet hebben. Eén van de drie lezers een extra terugval geven is
    // een rij die hier goed lijkt en om 03:00 faalt.
    reset();
    PRINCIPAL_ORG = null;                       // geen home-org
    PUBLISHED_AGENTS = [agent({ id: 'agt_ok', organization_id: 'org1' })];
    const body = await getCatalog();
    assert.strictEqual(body.agents.length, 1);
    assert.strictEqual(body.agents[0].canUse, false);
    assert.strictEqual(body.agents[0].reason, 'other_org');
});

test('gedeeld zonder ooit een VERSIE te publiceren is niet kiesbaar, met de juiste raad', async () => {
    // De publiceer-schakelaar staat aan, maar `getForRuntime` serveert nog het
    // levende klad van de eigenaar. Een onbewaakte automatisering van een ander mag
    // daar niet op draaien; de zin die de kiezer toont is "publiceer hem", en
    // dat is precies de handeling die het oplost.
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
