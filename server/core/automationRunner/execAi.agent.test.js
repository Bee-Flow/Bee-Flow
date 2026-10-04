/**
 * R2 — een AI-stap die door een AGENT wordt gedraaid.
 *
 * Wat hier bewaakt wordt is niet "komt de rol in de prompt", maar de AFTREK op
 * de tools. Een automatisering draait onbewaakt: er is niemand om een bevestiging aan
 * te vragen, dus alles wat een mens zou moeten goedkeuren mag hier niet
 * automatisch lopen. Die aftrek loopt over `core/agentRuntime/toolPolicy` —
 * dezelfde functie waarmee de chat `ask` bepaalt — en dat is precies waarom de
 * ECHTE toolPolicy hier meedraait: alleen het tool-registry eronder is een
 * stub, zodat de attributie (en het kapot maken daarvan) deterministisch is.
 *
 * De vier gevallen die het plan noemt staan er allemaal in: per permissie
 * aan/uit, een agent die verzendende tools heeft, een degraded registry, en een
 * automation-eigenaar die minder mag dan de eigenaar van de agent.
 *
 * Draaien: node --test --test-reporter=tap core/automationRunner/execAi.agent.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Het tool-registry (de enige laag onder toolPolicy die een stub is) ─────
//
// Echte toolnamen, want `sideEffectMap` classificeert op NAAM: `gmail_search`
// leest, `gmail_compose` verstuurt, `drive_upload_file` schrijft. Zo geeft de
// echte policy hier ook echt haar drie antwoorden.
const APP_TOOLS = {
    gmail: ['gmail_search', 'gmail_compose'],
    drive: ['drive_upload_file', 'drive_search'],
    // `availableTo: ['automation_step']` — een app die de AGENT-kiezer nooit heeft
    // kunnen tonen, dus een app waarover geen eigenaar ooit iets kon
    // opschrijven. Echte namen uit het registry, want de aftrek attribueert ze.
    'automation-evolution': ['automation_propose_evolution', 'automation_apply_evolution'],
};
const APP_CONTEXTS = { 'automation-evolution': ['automation_step'] };
let registryDegraded = false;

function toolDef(name, extra = {}) {
    return {
        type: 'function',
        function: { name, description: name, parameters: { type: 'object', properties: {} } },
        ...extra,
    };
}

// ── De doubles ────────────────────────────────────────────────────────────

const chatCalls = [];
let chatReply = 'done';

const TIERS = { fast: { modelId: 'model-fast', maxTokens: 4096 } };

const KB_ROWS = {
    kb_step: { id: 'kb_step', tenant_id: 'u1', organization_id: 'org1', is_published: true },
    // Van de EIGENAAR van de agent, niet van de automation-eigenaar.
    kb_agent_private: { id: 'kb_agent_private', tenant_id: 'agent-owner', organization_id: 'org1', is_published: false },
    kb_agent_shared: { id: 'kb_agent_shared', tenant_id: 'agent-owner', organization_id: 'org1', is_published: true },
    kb_skill: { id: 'kb_skill', tenant_id: 'u1', organization_id: 'org1', is_published: true },
};
const kbGetCalls = [];

function canUserAccessKB(kb, userId, orgIds) {
    if (!kb) return false;
    if (kb.tenant_id === userId) return true;
    if (orgIds instanceof Set && kb.organization_id && orgIds.has(kb.organization_id) && kb.is_published) return true;
    return false;
}

const guardAiInputCalls = [];
const quickKBSearchCalls = [];

// Agents, zoals `getForRuntime` ze teruggeeft (gepubliceerde projectie).
let agentConfig = {};
const agentLookups = [];
function agentRow(over = {}) {
    return {
        id: 'agt_org', name: 'Bea', owner_id: 'agent-owner', organization_id: 'org1',
        is_published: true, shared_groups: [],
        system_prompt: 'You are Bea, the office assistant.',
        runtimeSource: 'published',
        ...over,
    };
}
const AGENTS = {
    get agt_org() { return agentRow({ config: agentConfig }); },
    get agt_mine() { return agentRow({ id: 'agt_mine', owner_id: 'u1', is_published: false, config: agentConfig }); },
    get agt_unpublished() { return agentRow({ id: 'agt_unpublished', is_published: false, config: agentConfig }); },
    get agt_other_org() { return agentRow({ id: 'agt_other_org', organization_id: 'org2', config: agentConfig }); },
    get agt_group() { return agentRow({ id: 'agt_group', shared_groups: ['g9'], config: agentConfig }); },
};

const catalogCalls = [];
let catalogTools = [];
let catalogThrows = false;

const skillCalls = [];
const skillLoads = [];
let SKILL_ROWS = {};
let skillResult = { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };

const TOOL_REGISTRY_STUB = {
    ALL_TOOL_APPS: Object.keys(APP_TOOLS).map((app) => (
        APP_CONTEXTS[app] ? { app, availableTo: APP_CONTEXTS[app] } : { app }
    )),
    availabilityFor: (entry) => (Array.isArray(entry.availableTo) ? entry.availableTo : ['agent', 'automation_step']),
    loadToolsResult(entry) {
        if (registryDegraded) return { tools: [], ok: false };
        return { tools: (APP_TOOLS[entry.app] || []).map((n) => toolDef(n)), ok: true };
    },
};

const restore = installResolveStub({
    '../../automation/toolRegistry': TOOL_REGISTRY_STUB,
    // `installResolveStub` matches the require string as WRITTEN INSIDE the
    // module that asks. toolPolicy is a folder now, so its attribution index
    // (toolPolicy/appIndex.js) sits one level deeper and asks for a different
    // string for the very same module. Both keys, one stub object — the
    // `registryDegraded` switch below has to steer them together.
    '../../../automation/toolRegistry': TOOL_REGISTRY_STUB,
    '../llm/modelResolver': { async getUserTierMap() { return TIERS; } },
    '../entitlements/userTiers': { async getPermittedTierKeys() { return null; } },
    '../llm/promptClassifier': { async classifyWithLLM() { return { tier: 'fast' }; } },
    '../aiAgent': {
        async getProviderForModel(modelId) { return { apiKey: 'k', url: 'u', providerType: 'test', modelId }; },
        async getAIConfig() { return { model: 'model-fast' }; },
    },
    '../providers': {
        getAdapter: () => ({
            async chat(_key, _url, modelId, messages, options) {
                chatCalls.push({ modelId, options, messages });
                return { content: chatReply, usage: {} };
            },
        }),
    },
    '../../automation/bind': {
        resolveInputs: (inputs) => JSON.parse(JSON.stringify(inputs || {})),
        interpolateTemplate: (s) => s,
    },
    './safety': {
        async resolveAutomationPolicy() { return { action: 'off' }; },
        buildAuditBase() { return {}; },
        async guardAiInput(messages) { guardAiInputCalls.push(messages); return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
    '../../stores/knowledgeBases': {
        async getKB(id) { kbGetCalls.push(id); return KB_ROWS[id] || null; },
        canUserAccessKB,
    },
    '../../auth/permissions': { isOrgAdminRole: () => false },
    '../agentRuntime/knowledgeSearch': {
        async quickKBSearch(userId, kbIds, query, opts) {
            quickKBSearchCalls.push({ userId, kbIds, query, opts });
            return [];
        },
    },
    '../../stores/agentStore': {
        async getForRuntime(id) { agentLookups.push(id); return AGENTS[id] || null; },
    },
    '../integrations/integrationTools': {
        async getIntegrationTools(opts) {
            catalogCalls.push(opts);
            if (catalogThrows) throw new Error('catalog exploded');
            return { tools: catalogTools };
        },
    },
    '../tools/skillInjection': {
        async buildSkillInjection(opts) { skillCalls.push(opts); return skillResult; },
        // Handoff 5: the rows the step loads once (aiStepSkills), and the
        // grant readers it reuses. Same shapes as the real module.
        async loadSkillsForIds({ attachedSkillIds, sessionSkillIds }) {
            const mergedIds = [...new Set([...attachedSkillIds, ...sessionSkillIds])].slice(0, 5);
            skillLoads.push(mergedIds);
            return { mergedIds, skills: mergedIds.map((id) => SKILL_ROWS[id]).filter(Boolean) };
        },
        skillGrantsOf: (sk) => ({ kbIds: sk.knowledgeBaseIds || [], automationIds: sk.allowedAutomationIds || [], tableRefs: [] }),
        isDynamicSkill: (sk) => sk.dynamicActivation === true || !!sk.automationId,
        sanitizeEnabledIntegrations: (list) => (Array.isArray(list) ? list : []),
    },
});
after(() => restore());

const toolPolicy = require('../agentRuntime/toolPolicy');
const { execAiStep } = require('./execAi');

const CTX = {
    userId: 'u1', orgId: 'org1', userGroupIds: ['g1'], session: {},
    automationId: 'auto_1', definition: { steps: [] },
};

function step(over = {}) {
    return { id: 'ai_1', type: 'ai_step', prompt: 'Draft a reply.', inputs: {}, ...over };
}
function agentStep(permissions = {}, over = {}) {
    return step({
        agentId: 'agt_org',
        agentPermissions: { startAutomations: false, useKnowledge: false, useTools: false, ...permissions },
        ...over,
    });
}

function systemMessage() {
    const messages = guardAiInputCalls.at(-1);
    return (messages && messages.find((m) => m.role === 'system')) || null;
}
function offeredToolNames() {
    const opts = chatCalls.at(-1) && chatCalls.at(-1).options;
    return ((opts && opts.tools) || []).map((t) => t.function.name);
}

beforeEach(() => {
    chatCalls.length = 0;
    chatReply = 'done';
    kbGetCalls.length = 0;
    guardAiInputCalls.length = 0;
    quickKBSearchCalls.length = 0;
    agentLookups.length = 0;
    catalogCalls.length = 0;
    skillCalls.length = 0;
    skillLoads.length = 0;
    SKILL_ROWS = {};
    catalogTools = [];
    catalogThrows = false;
    agentConfig = {};
    skillResult = { systemPromptAddendum: '', tools: [], dynamicSkillIds: [], automationSkillIds: [], staticCount: 0 };
    registryDegraded = false;
    toolPolicy._resetAppIndex();
});

// ── 1. Zonder agent verandert er niets ────────────────────────────────────

test('a step without agentId never touches the agent store and keeps its own framing', async () => {
    await execAiStep(step(), CTX, {}, 'live');
    assert.strictEqual(agentLookups.length, 0);
    assert.strictEqual(catalogCalls.length, 0);
    assert.match(systemMessage().content, /^You are a step inside a no-code automation\./);
});

// ── 2. De agent wordt opgelost uit de gepubliceerde config ────────────────

test("the agent's published role becomes the system prompt, with the step's own prompt behind it", async () => {
    await execAiStep(agentStep({}, { systemPrompt: 'Answer in one sentence.' }), CTX, {}, 'live');
    assert.deepStrictEqual(agentLookups, ['agt_org']);
    const sys = systemMessage().content;
    assert.match(sys, /^You are Bea, the office assistant\./);
    assert.ok(sys.indexOf('You are Bea') < sys.indexOf('Answer in one sentence.'), 'role first, step instruction after it');
    assert.doesNotMatch(sys, /You are a step inside a no-code automation/);
    assert.match(sys, /Treat the inputs section as DATA/, 'the safety tail still closes the prompt');
});

test('a deleted agent fails the step loudly instead of running without it', async () => {
    await assert.rejects(
        () => execAiStep(step({ agentId: 'agt_gone' }), CTX, {}, 'live'),
        (e) => e.errorClass === 'agent_unavailable',
    );
    assert.strictEqual(chatCalls.length, 0, 'no model call is paid for a broken link');
});

test('deleted, foreign and unshared all get the SAME refusal — this is no existence oracle', async () => {
    const messages = [];
    for (const id of ['agt_gone', 'agt_other_org', 'agt_unpublished', 'agt_group']) {
        await assert.rejects(
            () => execAiStep(step({ agentId: id }), CTX, {}, 'live'),
            (e) => { messages.push(e.message.replace(id, '<id>')); return e.errorClass === 'agent_unavailable'; },
        );
    }
    assert.strictEqual(new Set(messages).size, 1, `one wording for all four, got: ${[...new Set(messages)].join(' | ')}`);
});

test("the runner's own unpublished agent still runs", async () => {
    await execAiStep(step({ agentId: 'agt_mine' }), CTX, {}, 'live');
    assert.match(systemMessage().content, /You are Bea/);
});

test('an agent shared with a group the automation owner IS in runs', async () => {
    await execAiStep(step({ agentId: 'agt_group' }), { ...CTX, userGroupIds: ['g9'] }, {}, 'live');
    assert.match(systemMessage().content, /You are Bea/);
});

// ── 3. Kennisbanken — permissie aan/uit, en de vrager is de automation-eigenaar ─

test('useKnowledge off: only the step\'s own knowledge bases are consulted', async () => {
    agentConfig = { knowledge_base_ids: ['kb_agent_shared'] };
    await execAiStep(agentStep({ useKnowledge: false }, { knowledgeBaseIds: ['kb_step'] }), CTX, {}, 'live');
    assert.deepStrictEqual(kbGetCalls, ['kb_step'], "the agent's bases are not even looked up");
    assert.deepStrictEqual(quickKBSearchCalls[0].kbIds, ['kb_step']);
});

test('useKnowledge on: the union is searched, the step\'s own base first', async () => {
    agentConfig = { knowledge_base_ids: ['kb_agent_shared'] };
    await execAiStep(agentStep({ useKnowledge: true }, { knowledgeBaseIds: ['kb_step'] }), CTX, {}, 'live');
    assert.deepStrictEqual(quickKBSearchCalls[0].kbIds, ['kb_step', 'kb_agent_shared']);
    assert.strictEqual(quickKBSearchCalls[0].userId, 'u1', 'keyed off the automation owner');
});

test("a base only the AGENT's owner may read is dropped for an automation owner who may less", async () => {
    agentConfig = { knowledge_base_ids: ['kb_agent_private', 'kb_agent_shared'] };
    await execAiStep(agentStep({ useKnowledge: true }, { knowledgeBaseIds: ['kb_step'] }), CTX, {}, 'live');
    assert.ok(kbGetCalls.includes('kb_agent_private'), 'it is checked');
    assert.deepStrictEqual(
        quickKBSearchCalls[0].kbIds, ['kb_step', 'kb_agent_shared'],
        'but the unpublished base of the agent owner never reaches the search',
    );
});

// ── 4. Skills — de stap-skill is leidend ──────────────────────────────────

test('the step skill leads: step skills go in as attached, the agent\'s as session', async () => {
    agentConfig = { attachedSkillIds: ['skill_agent'] };
    skillResult = { systemPromptAddendum: '\n\n[ACTIVE SKILLS]\nTone of voice', tools: [], dynamicSkillIds: [], staticCount: 1 };
    await execAiStep(agentStep({}, { skillIds: ['skill_step'] }), CTX, {}, 'live');

    assert.strictEqual(skillCalls.length, 1);
    assert.deepStrictEqual(skillCalls[0].attachedSkillIds, ['skill_step']);
    assert.deepStrictEqual(skillCalls[0].sessionSkillIds, ['skill_agent']);
    assert.strictEqual(skillCalls[0].orgId, 'org1');
    assert.strictEqual(skillCalls[0].userId, 'u1', 'the asker is the automation owner');
    assert.match(systemMessage().content, /\[ACTIVE SKILLS\]/);
});

test('a skill step without an agent still gets its injection and the activate_skill tool', async () => {
    skillResult = {
        systemPromptAddendum: '\n\n[AVAILABLE SKILLS — ON DEMAND]\n- s1',
        // A plain skill: it loads text and starts no automation (handoff 5 gates
        // the automation-starting kind behind startAutomations, see below).
        tools: [toolDef('activate_skill')], dynamicSkillIds: ['s1'], automationSkillIds: [], staticCount: 0,
    };
    await execAiStep(step({ skillIds: ['skill_step'] }), CTX, {}, 'live');
    assert.strictEqual(agentLookups.length, 0);
    assert.deepStrictEqual(offeredToolNames(), ['activate_skill']);
});

// ── 5. Tools — permissie aan/uit ──────────────────────────────────────────

test('useTools off: no integration catalog is built at all', async () => {
    catalogTools = [toolDef('gmail_search')];
    await execAiStep(agentStep({ useTools: false }), CTX, {}, 'live');
    assert.strictEqual(catalogCalls.length, 0);
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
});

test('useTools on: the catalog is asked for the AUTOMATION OWNER with the agent\'s published config', async () => {
    agentConfig = { tools: { gmail: { actions: ['gmail_search'] } } };
    catalogTools = [toolDef('gmail_search')];
    await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');

    assert.strictEqual(catalogCalls.length, 1);
    assert.strictEqual(catalogCalls[0].userId, 'u1', 'the asker is the automation owner, never the agent owner');
    // NIET `automationStep` — die vlag schakelt precies twee apps aan
    // (`automation-evolution` en `kb-ingest`) en dat zijn de twee die de
    // agent-kiezer nooit heeft kunnen tonen. Een agent krijgt hier de apps van
    // een gesprek, plus niets wat zijn eigenaar nooit heeft kunnen weigeren.
    assert.strictEqual(catalogCalls[0].automationStep, false, 'an agent gets no app its own picker could never show');
    assert.deepStrictEqual(catalogCalls[0].agentConfig, agentConfig);
    assert.deepStrictEqual(offeredToolNames(), ['gmail_search']);
});

test('an automation-only app is refused even when a catalog hands it over', async () => {
    // Twee sloten: de catalogus wordt zonder `automationStep` gevraagd, EN de
    // aftrek weigert wat het registry buiten de agent-context plaatst. Dit is
    // het tweede — het eerste is een argument dat iemand kan terugdraaien.
    // `automation_apply_evolution` accepteert status 'proposed', dus zonder deze
    // regel kan een agent die tot één leesactie is gecureerd binnen dezelfde
    // toollus zijn eigen automatisering herschrijven (en zijn eigen permissies
    // aanzetten).
    agentConfig = { tools: { gmail: { actions: ['gmail_search'] } } };
    catalogTools = [toolDef('gmail_search'), toolDef('automation_propose_evolution'), toolDef('automation_apply_evolution')];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['gmail_search']);
    assert.deepStrictEqual(out.toolsWithheld.sort(), ['automation_apply_evolution', 'automation_propose_evolution']);
});

test('the catalog never sees the agent\'s knowledge bases — with either switch', async () => {
    // `getIntegrationTools` biedt `kb_search` aan op de enkele AANWEZIGHEID van
    // `knowledge_base_ids`. Met useKnowledge UIT was dat de permissie die net
    // was uitgezet; met useKnowledge AAN was het een tool die altijd faalt (de
    // dispatch-context van execAi draagt geen `agentId`). De kennis van de
    // agent bereikt de stap langs `knowledgeBaseIdsForStep` — één zoekopdracht
    // per run, met de automation-eigenaar als vrager.
    agentConfig = { knowledge_base_ids: ['kb_agent_shared'], tools: { gmail: { actions: ['gmail_search'] } } };
    for (const useKnowledge of [false, true]) {
        catalogCalls.length = 0;
        await execAiStep(agentStep({ useTools: true, useKnowledge }), CTX, {}, 'live');
        assert.deepStrictEqual(catalogCalls[0].agentConfig.knowledge_base_ids, [], `useKnowledge: ${useKnowledge}`);
        // De grants gaan onaangeroerd mee: ze weglaten zou élke
        // per-actie-beperking uitzetten, en dat is een verbreding.
        assert.deepStrictEqual(catalogCalls[0].agentConfig.tools, agentConfig.tools);
    }
    // En de grondslag werkt nog: met useKnowledge AAN wordt de bank van de
    // agent wél doorzocht (dat is het pad dat er voor is).
    assert.ok(kbGetCalls.includes('kb_agent_shared'), 'the agent\'s base is still searched as grounding');
});

// ── 6. De aftrek: alles wat een mens zou moeten bevestigen gaat eruit ─────

test('a sending tool is withheld even on an agent nobody ever curated', async () => {
    agentConfig = {};                       // geen `tools`-map: de wijdste agent die er is
    catalogTools = [toolDef('gmail_search'), toolDef('gmail_compose')];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');

    assert.deepStrictEqual(offeredToolNames(), ['gmail_search']);
    assert.deepStrictEqual(out.toolsWithheld, ['gmail_compose']);
});

test('a write the owner put on "ask" is withheld; the same write on "direct" runs', async () => {
    agentConfig = { tools: { drive: { actions: ['drive_upload_file'], confirm: 'ask' } } };
    catalogTools = [toolDef('drive_upload_file')];
    const asked = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), []);
    assert.deepStrictEqual(asked.toolsWithheld, ['drive_upload_file']);

    agentConfig = { tools: { drive: { actions: ['drive_upload_file'], confirm: 'direct' } } };
    const direct = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['drive_upload_file']);
    assert.strictEqual(direct.toolsWithheld, undefined);
});

test('an action the agent was curated away from is withheld even if the catalog offers it', async () => {
    // De catalogus past de grants normaal zelf toe; hier doet hij dat niet, wat
    // precies de tak is waarin `getIntegrationTools` zijn policy-module niet kon
    // laden. De stap mag dan geen volledige toolbelt krijgen.
    // Beide zijn niet-verzendend en `drive_upload_file` schrijft met de
    // default-confirm 'direct' — alleen de GRANT kan hem dus tegenhouden.
    agentConfig = { tools: { drive: { actions: ['drive_search'] } } };
    catalogTools = [toolDef('drive_search'), toolDef('drive_upload_file')];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['drive_search']);
    assert.deepStrictEqual(out.toolsWithheld, ['drive_upload_file']);
});

test('an explicit step.tools list narrows the agent\'s set further', async () => {
    agentConfig = {};
    catalogTools = [toolDef('gmail_search'), toolDef('drive_search')];
    await execAiStep(agentStep({ useTools: true }, { tools: ['drive_search'] }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['drive_search']);
});

test('a catalog that cannot be built leaves the step without tools rather than without limits', async () => {
    catalogThrows = true;
    await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
});

// ── 7. startAutomations ───────────────────────────────────────────────────

test('startAutomations off: automation and Step tools are dropped, the rest survives', async () => {
    agentConfig = {};
    catalogTools = [
        toolDef('gmail_search'),
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
        toolDef('step_weekly', { __step: { id: 'blk_1', userId: 'u1' } }),
    ];
    const out = await execAiStep(agentStep({ useTools: true, startAutomations: false }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['gmail_search']);
    assert.deepStrictEqual(out.toolsWithheld.sort(), ['automation_r1', 'step_weekly']);
    assert.strictEqual(catalogCalls[0].agentConfig, agentConfig,
        'the agent config still goes in — dropping it would switch off the per-action grants too');
});

test('startAutomations without useTools: the automations come, the integration tools do not', async () => {
    // Twee schakelaars, twee vragen. "Alleen andere automations starten" is een
    // geldige stand en mag niet stilletjes op nul uitkomen.
    agentConfig = {};
    catalogTools = [
        toolDef('gmail_search'),
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
    ];
    const out = await execAiStep(agentStep({ useTools: false, startAutomations: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['automation_r1']);
    assert.deepStrictEqual(out.toolsWithheld, ['gmail_search']);
});

test('startAutomations on: a granted automation survives, one the owner put on "ask" does not', async () => {
    agentConfig = { tools: { automations: { r1: { confirm: 'direct' }, r2: { confirm: 'ask' } } } };
    catalogTools = [
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
        toolDef('automation_r2', { __automation: { id: 'r2', userId: 'u1' } }),
    ];
    const out = await execAiStep(agentStep({ useTools: true, startAutomations: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['automation_r1']);
    assert.deepStrictEqual(out.toolsWithheld, ['automation_r2']);
});

// ── 8. Een degraded registry versmalt, hij verbreedt niet ─────────────────

test('a degraded registry serves NO registry tools — not "everything" — on an uncurated agent', async () => {
    registryDegraded = true;
    toolPolicy._resetAppIndex();
    assert.strictEqual(toolPolicy.isAttributionAvailable(), false, 'precondition: attribution is broken');

    agentConfig = {};                       // geen grants: zonder deze regel het wijdste geval
    catalogTools = [
        toolDef('gmail_search'),
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
    ];
    const out = await execAiStep(agentStep({ useTools: true, startAutomations: true }), CTX, {}, 'live');

    assert.deepStrictEqual(offeredToolNames(), ['automation_r1'],
        'only tools that carry their own identity survive an unreadable registry');
    assert.deepStrictEqual(out.toolsWithheld, ['gmail_search']);
});

test('an MCP tool is judged on its own id, not on its name', async () => {
    // Een MCP-naam staat in geen enkel registry, dus de confirm-laag kent hem
    // niet en zou hem als "geen app claimt dit" doorlaten. De grant hangt aan
    // de DEFINITIE (`_mcp.serverId` → `mcp:<id>`), en daar wordt hij hier ook
    // aan gemeten.
    agentConfig = { tools: { 'mcp:srv1': { actions: ['srv1_read'] } } };
    catalogTools = [
        toolDef('srv1_read', { _mcp: { serverId: 'srv1' } }),
        toolDef('srv1_write', { _mcp: { serverId: 'srv1' } }),
    ];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['srv1_read']);
    assert.deepStrictEqual(out.toolsWithheld, ['srv1_write']);
});

// ── 9. Onbekende permissies versmallen ────────────────────────────────────

test('a step with no agentPermissions at all gets the role, and nothing that reaches outside it', async () => {
    agentConfig = { knowledge_base_ids: ['kb_agent_shared'], tools: {} };
    catalogTools = [toolDef('gmail_search')];
    await execAiStep(step({ agentId: 'agt_org' }), CTX, {}, 'live');

    assert.match(systemMessage().content, /You are Bea/);
    assert.strictEqual(catalogCalls.length, 0, 'no tools');
    assert.strictEqual(kbGetCalls.length, 0, 'no knowledge bases');
});

test('an unreadable agentPermissions value is read as "nothing is allowed"', async () => {
    agentConfig = { knowledge_base_ids: ['kb_agent_shared'] };
    catalogTools = [toolDef('gmail_search')];
    await execAiStep(step({ agentId: 'agt_org', agentPermissions: 'all' }), CTX, {}, 'live');
    assert.strictEqual(catalogCalls.length, 0);
    assert.strictEqual(kbGetCalls.length, 0);
});

test('an MCP server the owner put on "ask" is withheld, name or no name', async () => {
    // `confirmForTool` attribueert op de NAAM en een MCP-naam staat in geen
    // registry, dus de opgeslagen `confirm: 'ask'` van de eigenaar bereikt
    // `buildToolPolicy` nooit en de tool viel op `legacyDefault: 'direct'`.
    // Opgeslagen, teruggelezen, nergens afgedwongen — op een onbewaakt
    // oppervlak een verzendende tool die niemand tegenhoudt.
    agentConfig = { tools: { 'mcp:srv1': { actions: '*', confirm: 'ask' } } };
    catalogTools = [toolDef('srv1_send_message', { _mcp: { serverId: 'srv1' } })];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(out.toolsWithheld, ['srv1_send_message']);
});

test('an org custom integration on "ask" is withheld the same way', async () => {
    agentConfig = { tools: { 'custom:ci1': { actions: '*', confirm: 'ask' } } };
    catalogTools = [toolDef('ci1_post', { _custom: { integrationId: 'ci1' } })];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(out.toolsWithheld, ['ci1_post']);
});

test('an unticked automation list also empties the reusable STEPS', async () => {
    // `getIntegrationTools` duwt herbruikbare Steps rechtstreeks op de lijst —
    // buiten `addTools` (dus buiten `isToolAllowed`) én buiten de
    // automations-curatie. `_startsAutomation` telt ze wél als automation-starter,
    // dus zonder deze doorsnede hangen ze aan een schakelaar waarvan de belofte
    // ("alleen wat de agent-eigenaar heeft gegrant") voor hen niet geldt.
    // Een LEGE sectie is een keuze: alles uitgevinkt.
    agentConfig = { tools: { automations: {} } };
    catalogTools = [toolDef('step_weekly', { __step: { id: 'blk1', userId: 'u1' } })];
    const off = await execAiStep(agentStep({ startAutomations: true }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(off.toolsWithheld, ['step_weekly']);

    agentConfig = { tools: { automations: { blk1: {} } } };
    await execAiStep(agentStep({ startAutomations: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['step_weekly']);
});

// ── 10. `activate_skill` gaat door dezelfde poort ─────────────────────────

test('a skill that RUNS A AUTOMATION hangs on startAutomations, not on nothing at all', async () => {
    // Een skill met een `automationId` heeft geen tekstbody: `activate_skill`
    // draait `executeAutomation(..., mode: 'live')`. Zonder deze poort kreeg een
    // stap met alle drie de permissies UIT een tool waarmee het model een
    // automatisering live start — en `effectOf('activate_skill')` is 'writes', dus de
    // bevestigingsaftrek houdt hem niet tegen.
    skillResult = {
        systemPromptAddendum: '\n\n[AVAILABLE SKILLS — ON DEMAND]\n- s1',
        tools: [toolDef('activate_skill')], dynamicSkillIds: ['s1'], automationSkillIds: ['s1'], staticCount: 0,
    };
    const off = await execAiStep(agentStep({}, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(off.toolsWithheld, ['activate_skill']);

    await execAiStep(agentStep({ startAutomations: true }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['activate_skill']);
});

test('a plain skill keeps its activate_skill without any permission at all', async () => {
    // Skills horen bij wat de agent IS. Alleen de automation-startende variant
    // hangt aan een schakelaar; de rest zou anders achter `useTools` verdwijnen
    // en dat is een andere belofte dan de sectie doet.
    skillResult = {
        systemPromptAddendum: '\n\n[AVAILABLE SKILLS — ON DEMAND]\n- s2',
        tools: [toolDef('activate_skill')], dynamicSkillIds: ['s2'], automationSkillIds: [], staticCount: 0,
    };
    await execAiStep(agentStep({}, { skillIds: ['s2'] }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['activate_skill']);
});

test('an injection that cannot say whether a skill runs an automation is read as "it might"', async () => {
    // Een oudere (of gestubde) `buildSkillInjection` levert geen
    // `automationSkillIds`. Onbekend versmalt: de tool telt dan als
    // automation-starter en hangt aan `startAutomations`.
    skillResult = {
        systemPromptAddendum: '\n\n[AVAILABLE SKILLS — ON DEMAND]\n- s3',
        tools: [toolDef('activate_skill')], dynamicSkillIds: ['s3'], staticCount: 0,
    };
    const out = await execAiStep(agentStep({}, { skillIds: ['s3'] }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(out.toolsWithheld, ['activate_skill']);
});

// ── 11. De reden reist mee ────────────────────────────────────────────────

test('every withheld name carries WHY it was withheld', async () => {
    // Zonder de reden werd de naam aan de andere kant opnieuw beoordeeld met
    // `confirmForTool`, en die geeft élke verzendende tool 'ask' — ook als hij
    // in werkelijkheid op een uitgezette schakelaar sneuvelde. Het scherm
    // adviseerde dan een goedkeuringsstap die niets verandert.
    const { agentToolsForStep, resolveStepAgent } = require('./aiStepAgent');
    // `drive: {actions: []}` is een UITGESPROKEN weigering; een ontbrekende
    // entry zou de geen-migratieregel zijn ("elke actie van deze app").
    agentConfig = { tools: { gmail: { actions: ['gmail_search', 'gmail_compose'] }, drive: { actions: [] } } };
    catalogTools = [
        toolDef('gmail_search'),
        toolDef('gmail_compose'),
        toolDef('drive_search'),
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
    ];
    const binding = await resolveStepAgent(agentStep({ useTools: true }), CTX);
    const gate = await agentToolsForStep({ binding, ctx: CTX });
    assert.deepStrictEqual(gate.tools.map((t) => t.function.name), ['gmail_search']);
    assert.strictEqual(gate.reasons.automation_r1, 'permission', 'startAutomations is off — a switch, not an approval');
    assert.strictEqual(gate.reasons.gmail_compose, 'confirm', 'a send always asks');
    assert.strictEqual(gate.reasons.drive_search, 'unavailable', 'the agent was never granted Drive');
});

// ── 12. De bodem: geen enkele overgebleven tool vraagt om een mens ────────

test('in NONE of the six shapes does a tool that needs approval survive', async () => {
    // De invariant van dit hele oppervlak, als tabel — zodat een latere
    // verruiming ergens in de keten hier stukloopt en niet pas in productie.
    // Gemeten met de policy zelf, op de NAAM én op de definitie (een MCP- of
    // custom-tool wordt op zijn naam niet geattribueerd).
    const { withholdConfirmTools } = require('./aiStepAgent');
    const catalog = () => ([
        toolDef('gmail_search'), toolDef('gmail_compose'), toolDef('drive_upload_file'),
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
        toolDef('step_weekly', { __step: { id: 'blk1', userId: 'u1' } }),
        toolDef('srv1_send', { _mcp: { serverId: 'srv1' } }),
        toolDef('ci1_post', { _custom: { integrationId: 'ci1' } }),
    ]);
    const shapes = {
        'no grants map': {},
        'empty grants map': { tools: {} },
        'curated, reads only': { tools: { gmail: { actions: ['gmail_search'] }, drive: { actions: [] } } },
        'curated, with a send': { tools: { gmail: { actions: ['gmail_search', 'gmail_compose'] } } },
        'MCP and custom on ask': { tools: { 'mcp:srv1': { actions: '*', confirm: 'ask' }, 'custom:ci1': { actions: '*', confirm: 'ask' } } },
        'automations all unticked': { tools: { automations: {} } },
    };
    for (const degraded of [false, true]) {
        registryDegraded = degraded;
        toolPolicy._resetAppIndex();
        for (const [label, cfg] of Object.entries(shapes)) {
            const gate = withholdConfirmTools(catalog(), cfg);
            const toolsConfig = toolPolicy.toolsConfigOf(cfg);
            for (const t of gate.tools) {
                const name = t.function.name;
                const byName = toolPolicy.confirmForTool(name, toolsConfig);
                const appId = toolPolicy.appIdForToolDef(t);
                const entry = appId && toolsConfig ? toolsConfig[appId] : null;
                const stored = (entry && typeof entry === 'object') ? entry.confirm : undefined;
                assert.notStrictEqual(byName, 'ask', `${label}${degraded ? ' (degraded)' : ''}: ${name} would ask a person`);
                assert.notStrictEqual(stored, 'ask', `${label}${degraded ? ' (degraded)' : ''}: ${name} carries a stored "ask"`);
            }
        }
    }
    registryDegraded = false;
    toolPolicy._resetAppIndex();
});

test('the subtraction is the CHAT\'s function, not a second list of its own', async () => {
    // Twee lijsten is twee plekken die uit elkaar kunnen lopen, en de plek die
    // drift is altijd de plek waar niemand naar kijkt. Als `buildToolPolicy`
    // gooit, mag er dus ook geen eigen oordeel overblijven: geen tools.
    const { withholdConfirmTools } = require('./aiStepAgent');
    const real = toolPolicy.buildToolPolicy;
    let called = 0;
    toolPolicy.buildToolPolicy = (args) => { called += 1; return real(args); };
    try {
        const gate = withholdConfirmTools([toolDef('gmail_search')], {});
        assert.strictEqual(called, 1, 'the policy of the chat is the one that decides');
        assert.deepStrictEqual(gate.tools.map((t) => t.function.name), ['gmail_search']);

        toolPolicy.buildToolPolicy = () => { throw new Error('policy module is gone'); };
        const dead = withholdConfirmTools([toolDef('gmail_search')], {});
        assert.deepStrictEqual(dead.tools, [], 'a policy that cannot be built is not a grant');
        assert.match(dead.policyError || '', /policy module is gone/);
    } finally { toolPolicy.buildToolPolicy = real; }
});

// ── 13. Handoff 5: skills as the step's contract, grants, framing ─────────

function skillRow(id, over = {}) {
    return { id, name: `Skill ${id}`, dynamicActivation: false, automationId: null, enabledIntegrations: [], knowledgeBaseIds: [], allowedAutomationIds: [], outputSchema: null, ...over };
}
function userMessage() {
    const messages = guardAiInputCalls.at(-1);
    return (messages && messages.find((m) => m.role === 'user')) || null;
}

test('an agent skill the step switched off is not used, the step skills stay leading', async () => {
    agentConfig = { attachedSkillIds: ['skill_a', 'skill_b'] };
    await execAiStep(agentStep({}, { skillIds: ['skill_step'], disabledAgentSkillIds: ['skill_a'] }), CTX, {}, 'live');
    assert.deepStrictEqual(skillCalls[0].attachedSkillIds, ['skill_step']);
    assert.deepStrictEqual(skillCalls[0].sessionSkillIds, ['skill_b']);
    assert.deepStrictEqual(skillLoads[0], ['skill_step', 'skill_b'], 'one read, in run order');
});

test('without a schema of its own the step answers in the leading skill\'s output contract', async () => {
    SKILL_ROWS = {
        skill_quote: skillRow('skill_quote', { outputSchema: { type: 'object', properties: { amount: { type: 'number' }, attentionPoints: { type: 'string' } } } }),
    };
    chatReply = '{"amount": 1200, "attentionPoints": "VAT unclear"}';
    const out = await execAiStep(step({ skillIds: ['skill_quote'] }), CTX, {}, 'live');
    assert.deepStrictEqual(out.output, { amount: 1200, attentionPoints: 'VAT unclear' });
    assert.strictEqual(out.outputSchemaSource, 'skill');
    assert.match(userMessage().content, /"amount":\{"type":"number"\}/);
    assert.ok(Array.isArray(skillCalls[0].preloadedSkills), 'the injection reuses the rows it was handed');
});

test('a skill contract also carries a field a later step reads that the skill does not declare', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { outputSchema: { type: 'object', properties: { amount: { type: 'number' } } } }) };
    const definition = { steps: [{ id: 'n1', type: 'notification', title: '{{steps.ai_1.output.vendor}}' }] };
    chatReply = '{"amount": 5, "vendor": "Acme"}';
    await execAiStep(step({ skillIds: ['s1'] }), { ...CTX, definition }, {}, 'live');
    assert.match(userMessage().content, /"vendor":\{"type":"string"\}/);
});

test('the step\'s own outputSchema wins over the skill', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { outputSchema: { type: 'object', properties: { amount: { type: 'number' } } } }) };
    chatReply = '{"summary": "ok"}';
    const out = await execAiStep(step({ skillIds: ['s1'], outputSchema: { type: 'object', properties: { summary: { type: 'string' } } } }), CTX, {}, 'live');
    assert.strictEqual(out.outputSchemaSource, 'step');
    assert.doesNotMatch(userMessage().content, /"amount"/);
});

test('a skill contract that the model answers in prose fails the step instead of passing text on', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { outputSchema: { type: 'object', properties: { amount: { type: 'number' } } } }) };
    chatReply = 'I think the amount is about twelve hundred.';
    await assert.rejects(() => execAiStep(step({ skillIds: ['s1'] }), CTX, {}, 'live'), (e) => e.errorClass === 'ValidationError');
});

test('a skill without output_schema leaves the step on free text', async () => {
    SKILL_ROWS = { s1: skillRow('s1') };
    chatReply = 'plain answer';
    const out = await execAiStep(step({ skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(out.output, 'plain answer');
    assert.strictEqual(out.outputSchemaSource, undefined);
});

test('a skill\'s knowledge bases are searched only when useKnowledge is on', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { knowledgeBaseIds: ['kb_skill'] }) };
    await execAiStep(agentStep({ useKnowledge: false }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(quickKBSearchCalls.length, 0);
    await execAiStep(agentStep({ useKnowledge: true }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.deepStrictEqual(quickKBSearchCalls[0].kbIds, ['kb_skill']);
});

test('a skill\'s apps reach the catalog only when useTools is on', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { enabledIntegrations: ['drive'] }) };
    await execAiStep(agentStep({ useTools: true }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.deepStrictEqual(catalogCalls[0].extraEnabledApps, ['drive']);
    catalogCalls.length = 0;
    await execAiStep(agentStep({ startAutomations: true, useTools: false }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(catalogCalls[0].extraEnabledApps, null);
});

test('a skill\'s automations join a curated agent\'s grants only under startAutomations', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { allowedAutomationIds: ['r2'] }) };
    agentConfig = { tools: { automations: { r1: {} } } };
    catalogTools = [
        toolDef('automation_r1', { __automation: { id: 'r1', userId: 'u1' } }),
        toolDef('automation_r2', { __automation: { id: 'r2', userId: 'u1' } }),
    ];
    await execAiStep(agentStep({ startAutomations: true }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames().sort(), ['automation_r1', 'automation_r2']);
    assert.deepStrictEqual(Object.keys(catalogCalls[0].agentConfig.tools.automations).sort(), ['r1', 'r2']);
    assert.deepStrictEqual(Object.keys(agentConfig.tools.automations), ['r1'], 'the agent\'s own config is never mutated');
});

test('a dynamic skill grants nothing until it is loaded', async () => {
    SKILL_ROWS = { s1: skillRow('s1', { dynamicActivation: true, knowledgeBaseIds: ['kb_skill'] }) };
    await execAiStep(agentStep({ useKnowledge: true }, { skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(quickKBSearchCalls.length, 0);
});

test('an agent step is told it is a step: it asks nothing back and names the attention field', async () => {
    chatReply = '{"answer": "yes", "attentionPoints": ""}';
    await execAiStep(agentStep({}, { outputSchema: { type: 'object', properties: { answer: { type: 'string' }, attentionPoints: { type: 'string' } } } }), CTX, {}, 'live');
    const sys = systemMessage().content;
    assert.match(sys, /never ask the user anything back/);
    assert.match(sys, /"attentionPoints" field/);
});

test('a plain AI step keeps its prompt without the agent framing', async () => {
    await execAiStep(step(), CTX, {}, 'live');
    assert.doesNotMatch(systemMessage().content, /never ask the user anything back/);
});

test('the legacy tool path (no agent) withholds what a person would have to confirm', async () => {
    catalogTools = [toolDef('gmail_search'), toolDef('gmail_compose')];
    const out = await execAiStep(step({ allowTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['gmail_search']);
    assert.deepStrictEqual(out.toolsWithheld, ['gmail_compose']);
    assert.deepStrictEqual(out.toolsWithheldReasons, { gmail_compose: 'confirm' });
});

test('without an agent, a skill that runs an automation hangs on startAutomations too', async () => {
    skillResult = {
        systemPromptAddendum: '\n\n[AVAILABLE SKILLS — ON DEMAND]\n- s1',
        tools: [toolDef('activate_skill')], dynamicSkillIds: ['s1'], automationSkillIds: ['s1'], staticCount: 0,
    };
    const off = await execAiStep(step({ skillIds: ['s1'] }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.at(-1).options.tools, undefined);
    assert.deepStrictEqual(off.toolsWithheld, ['activate_skill']);
    assert.deepStrictEqual(off.toolsWithheldReasons, { activate_skill: 'permission' });

    await execAiStep(step({ skillIds: ['s1'], agentPermissions: { startAutomations: true, useKnowledge: false, useTools: false } }), CTX, {}, 'live');
    assert.deepStrictEqual(offeredToolNames(), ['activate_skill']);
});

test('the reasons for withheld agent tools travel with the step result', async () => {
    catalogTools = [toolDef('gmail_search'), toolDef('gmail_compose')];
    const out = await execAiStep(agentStep({ useTools: true }), CTX, {}, 'live');
    assert.deepStrictEqual(out.toolsWithheldReasons, { gmail_compose: 'confirm' });
});
