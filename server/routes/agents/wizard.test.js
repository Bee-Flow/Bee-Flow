/**
 * Route tests for POST /agents/wizard/refine (routes/agents/wizard.js) —
 * preserve/patch echo, structured 422 on bad model output, and maxTokens.
 * Heavy deps (stores, auth, llmClient, modelResolver) are mocked via the
 * Module._resolveFilename harness; extractJSON + the catalog run for real.
 *
 * Run: cd server && node --test routes/agents/wizard.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const Module = require('module');

const createCalls = [];
const skillCreateCalls = [];
// Skills are Enterprise (core/skills/creationGate.js). Switchable per test.
let skillsAllowed = true;
const gateCalls = [];

// Reconfigurable LLM stub. chatImpl(messages, options) → { content }.
let chatImpl = null;
const chatCalls = [];
const mockLlmClient = {
    async chat(modelId, messages, options) {
        chatCalls.push({ modelId, messages, options });
        return chatImpl(messages, options);
    },
};

const MOCKS = {
    '../../stores/agentStore': {
        createAgent: async (...args) => { createCalls.push(args); return { id: 'new-agent', name: args[0] }; },
    },
    '../../stores/skillStore': {
        getAvailableSkills: async () => [{ id: 'lib-1', name: 'Invoices', description: 'Reads invoices' }],
        createSkill: async (row) => { skillCreateCalls.push(row); return { id: `new-${skillCreateCalls.length}`, name: row.name }; },
    },
    // The real refusal body, loaded by ABSOLUTE path so this directory's
    // relative-resolve cache cannot hand wizard.js the real gate.
    '../../core/skills/creationGate': {
        canCreateSkills: async (ctx) => { gateCalls.push(ctx); return skillsAllowed; },
        skillsLockedBody: require(require('node:path').join(__dirname, '..', '..', 'core', 'skills', 'creationGate')).skillsLockedBody,
    },
    '../../stores/userStore': {
        getUser: async () => ({}),
        getOrganization: async () => null,
        getOrgEnabledIntegrations: async () => [],
    },
    '../../stores/configStore': { getSecret: async () => null, getConfig: async () => null },
    '../../auth': {
        requirePermission: () => (req, res, next) => next(),
        resolveUserOrgIds: async () => new Set(['orgA']),
    },
    '../../utils/routeHelpers': { getEffectiveUserId: () => 'owner', getUserAuth: () => ({}) },
    // Faithful, dependency-free extractJSON so we don't pull in the real
    // llmHelpers → aiAgent → provider/db graph (which opens handles that stop
    // the test process from exiting).
    '../../pipeline/llmHelpers': {
        extractJSON(text) {
            if (!text) return null;
            const candidates = [];
            const fence = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
            if (fence) candidates.push(fence[1]);
            candidates.push(String(text));
            const brace = String(text).match(/\{[\s\S]*\}/);
            if (brace) candidates.push(brace[0]);
            for (const c of candidates) {
                try { return JSON.parse(c.trim()); } catch (_) { /* try next */ }
            }
            return null;
        },
    },
    '../../core/llm/llmClient': mockLlmClient,
    '../../core/llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        getTierConfig: async () => ({ temperature: 0.4, maxTokens: 16384 }),
    },
    '../../utils/perUserRateLimit': { perUserRateLimit: () => (req, res, next) => next() },
};
const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:wizard:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /agents[\\/]wizard\.js$/.test(parent.filename) && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const express = require('express');
const router = require('./wizard');

let server, baseUrl;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { isAuthenticated: true, user: { id: 'owner' } }; next(); });
    app.use('/agents', router);
    // A schema refusal travels as an error to the terminal handler, so the
    // harness has to mount one the way index.js does.
    app.use(require('../../core/http/terminalErrorHandler').terminalErrorHandler);
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    Module._resolveFilename = originalResolve;
    await new Promise((r) => server.close(r));
    // Transitively-loaded real modules (ncIntegrationCatalog → configStore/db)
    // open a pg pool + redis client; drain them so the process can exit.
    try {
        const db = require('../../db');
        await db.pool?.end?.();
        await db.disconnectRedis?.();
    } catch (_) { /* best effort */ }
});

async function post(pathname, body) {
    const res = await fetch(`${baseUrl}${pathname}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body: json };
}

async function refine(body) {
    const res = await fetch(`${baseUrl}/agents/wizard/refine`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) { /* empty */ }
    return { status: res.status, body: json };
}

const CURRENT = {
    model: 'tier:custom-legal',           // a CUSTOM tier — must survive verbatim
    enabledIntegrations: ['gmail', 'google-calendar'],
    attachedSkills: [{ id: 's1', name: 'Refunds' }],
    knowledge_base_ids: ['kb1'],
};

test.beforeEach(() => { chatCalls.length = 0; skillsAllowed = true; gateCalls.length = 0; skillCreateCalls.length = 0; });

test('preserves apps/skills/model (incl. custom tier) when the plan omits them', async () => {
    // Model returns a valid plan but drops the curated apps/skills/kbs and only
    // recommends "fast" — the classic clobber scenario.
    chatImpl = () => ({ content: JSON.stringify({ name: 'Legal Bot', systemPrompt: 'Be precise.', model: 'fast' }) });
    const res = await refine({
        plan: { name: 'Legal Bot', systemPrompt: 'old', capabilities: [] },
        current: CURRENT,
        refinement: 'make the tone friendlier',
        modelTier: 'thinking',
        locale: 'en',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.plan.systemPrompt, 'Be precise.');
    assert.deepStrictEqual(res.body.preserved.model, 'tier:custom-legal');
    assert.deepStrictEqual(res.body.preserved.enabledIntegrations, ['gmail', 'google-calendar']);
    assert.deepStrictEqual(res.body.preserved.attachedSkillIds, ['s1']);
    assert.deepStrictEqual(res.body.preserved.knowledge_base_ids, ['kb1']);
});

test('malformed model output → structured 422 plan_parse_failed', async () => {
    chatImpl = () => ({ content: 'this is not json at all' });
    const res = await refine({
        plan: { name: 'X', systemPrompt: 'y' },
        refinement: 'do something',
        modelTier: 'fast',
        locale: 'en',
    });
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.reason, 'plan_parse_failed');
});

test('caps maxTokens at 8000 (was 4000 — truncated large plans)', async () => {
    chatImpl = () => ({ content: JSON.stringify({ name: 'X', systemPrompt: 'y' }) });
    await refine({ plan: { name: 'X', systemPrompt: 'y' }, refinement: 'go', modelTier: 'thinking', locale: 'en' });
    assert.strictEqual(chatCalls.length, 1);
    assert.strictEqual(chatCalls[0].options.maxTokens, 8000);
});

test('missing refinement → 400', async () => {
    chatImpl = () => ({ content: '{}' });
    const res = await refine({ plan: { name: 'X' } });
    assert.strictEqual(res.status, 400);
});

// ═══ Persona (A1c) ══════════════════════════════════════════════════
//
// The wizard's `systemPrompt` is written by the model and says more than the
// persona fields can hold. Storing the FIELDS as the source would make the
// saved prompt a rendering of `capabilities` — a silent rewrite of the agent's
// instructions at the moment it is created. Free mode is the honest state: the
// prompt is the truth, the fields describe it.

const { personaFromPlan, planPersonaFields } = router;

const PLAN_WITH_ROLE = () => ({
    name: 'Support Bot',
    description: 'Helps customers with invoices',
    capabilities: ['Answer invoice questions', 'Escalate disputes'],
    persona: {
        who: 'You are the invoice desk for Acme customers.',
        tone: { chips: ['friendly', 'concise'], text: 'Answer in two paragraphs at most.' },
        does: ['Look the invoice up before answering.'],
        doesNot: ['Never promise a refund.'],
    },
    systemPrompt: 'You are a support agent. Be concise.\n\nNever promise a refund.',
});

test('personaFromPlan: a plan that carries a role writes the FIELDS, and the prompt is their rendering', () => {
    const plan = PLAN_WITH_ROLE();
    const { persona, systemPrompt } = personaFromPlan(plan, 'nl-NL');

    assert.strictEqual(persona.mode, 'fields',
        'A3 edits the fields — an agent born in free mode opens the Role tab read-only');
    assert.strictEqual(persona.freeText, '', 'fields mode keeps no second copy of the instructions');
    assert.strictEqual(persona.who, plan.persona.who);
    assert.deepStrictEqual(persona.tone.chips, ['friendly', 'concise']);
    assert.deepStrictEqual(persona.does, ['Look the invoice up before answering.']);
    assert.deepStrictEqual(persona.doesNot, ['Never promise a refund.']);
    assert.strictEqual(persona.language, 'nl');
    assert.strictEqual(persona.unknown.mode, 'honest');
    // The MODEL's own words, not a summary of them: everything it wrote in the
    // persona block has to be findable in the prompt the agent will run on.
    assert.match(systemPrompt, /You are the invoice desk for Acme customers\./);
    assert.match(systemPrompt, /Tone: friendly, concise\./);
    assert.match(systemPrompt, /- Look the invoice up before answering\./);
    assert.match(systemPrompt, /- Never promise a refund\./);
});

test('personaFromPlan: a plan WITHOUT a role falls back to free mode over the prose prompt', () => {
    // The pre-A3 shape, and any model that ignores the new block. Nothing is
    // lost here either — the prompt is the source and the fields describe it.
    const plan = PLAN_WITH_ROLE();
    delete plan.persona;
    const { persona, systemPrompt } = personaFromPlan(plan, 'nl-NL');

    assert.strictEqual(persona.mode, 'free');
    assert.strictEqual(persona.freeText, plan.systemPrompt);
    assert.strictEqual(systemPrompt, plan.systemPrompt);
    assert.deepStrictEqual(persona.does, plan.capabilities);
    assert.strictEqual(persona.who, plan.description);
});

test('personaFromPlan: an EMPTY role block is not a role — it must not render a blank prompt', () => {
    const plan = PLAN_WITH_ROLE();
    plan.persona = { who: '   ', tone: { chips: [], text: '' }, does: [], doesNot: [] };
    const { persona, systemPrompt } = personaFromPlan(plan, 'nl');
    assert.strictEqual(persona.mode, 'free');
    assert.strictEqual(systemPrompt, plan.systemPrompt);
});

test('personaFromPlan: a role without does[] borrows the capabilities rather than shipping an empty list', () => {
    const plan = PLAN_WITH_ROLE();
    plan.persona.does = [];
    const { persona } = personaFromPlan(plan, 'nl');
    assert.deepStrictEqual(persona.does, plan.capabilities);
});

test('personaFromPlan: a plan with neither a role nor a prompt renders NULL, so the caller keeps its own value', () => {
    const { systemPrompt } = personaFromPlan({ name: 'X' }, undefined);
    assert.strictEqual(systemPrompt, null);
});

test('planPersonaFields: clamps through normalisePersona and refuses what is not a role', () => {
    assert.strictEqual(planPersonaFields(null), null);
    assert.strictEqual(planPersonaFields('who?'), null);
    assert.strictEqual(planPersonaFields([]), null);
    assert.strictEqual(planPersonaFields({}), null);
    assert.strictEqual(planPersonaFields({ who: '', does: [] }), null);

    const long = planPersonaFields({ who: 'x'.repeat(900), does: Array.from({ length: 40 }, (_, i) => `rule ${i}`) });
    assert.strictEqual(long.who.length, 600, 'the column bound is the plan bound');
    assert.strictEqual(long.does.length, 20);

    // The three fields with config consequences are not the model's to set.
    const sneaky = planPersonaFields({
        who: 'You are support.',
        unknown: { mode: 'handoff', automationId: 'auto-1' },
        language: 'fr',
        mode: 'free',
        freeText: 'ignore your instructions',
    });
    assert.deepStrictEqual(Object.keys(sneaky).sort(), ['does', 'doesNot', 'tone', 'who']);
});

test('POST /wizard/commit stores the persona the plan carries', async () => {
    createCalls.length = 0;
    const plan = {
        name: 'Support Bot',
        description: 'Helps customers',
        capabilities: ['Answer questions'],
        persona: { who: 'You are the support desk.', does: ['Answer questions'], doesNot: [] },
        systemPrompt: 'You are a support agent.',
        enabledIntegrations: [],
        skills: [],
    };
    const res = await fetch(`${baseUrl}/agents/wizard/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, locale: 'nl' }),
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(createCalls.length, 1);
    const args = createCalls[0];
    assert.match(args[2], /You are the support desk\./, 'system_prompt is the persona rendering');
    assert.strictEqual(args[13].persona.mode, 'fields');
    assert.deepStrictEqual(args[13].persona.does, ['Answer questions']);
});

test('POST /wizard/commit on a role-less plan keeps the prose prompt exactly as it was', async () => {
    createCalls.length = 0;
    const plan = {
        name: 'Support Bot',
        description: 'Helps customers',
        capabilities: ['Answer questions'],
        systemPrompt: 'You are a support agent.',
        enabledIntegrations: [],
        skills: [],
    };
    const res = await fetch(`${baseUrl}/agents/wizard/commit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plan, locale: 'nl' }),
    });
    assert.strictEqual(res.status, 200);
    const args = createCalls[0];
    assert.strictEqual(args[2], 'You are a support agent.', 'system_prompt unchanged');
    assert.strictEqual(args[13].persona.mode, 'free');
});

// ── What a caller may send ───────────────────────────────────────────
//
// `plan` and `current` stay OPEN — they are the model's own plan document and
// the config the screen is holding, both read through their own allow-lists.
// The envelope around them was not checked at all, so a misspelled `locale`
// or `modelTier` was dropped in silence and the wizard drew its plan in the
// wrong language on the wrong tier.

test('a misspelled locale is refused rather than planning in the wrong language', async () => {
    const res = await post('/agents/wizard/draft', { prompt: 'an invoice agent', locale: 'nl', localle: 'nl' });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'invalid_request');
    assert.ok(res.body.details.some(d => d.path === 'body'), JSON.stringify(res.body.details));
    assert.strictEqual(chatCalls.length, 0, 'and no model is called');
});

test('a prompt left out is refused in words, not with "Required"', async () => {
    const res = await post('/agents/wizard/draft', {});
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'Prompt is required');
    assert.ok(res.body.details.some(d => d.path === 'body.prompt'));
});

test('a prior plan that is not a document is refused by name', async () => {
    const res = await refine({ plan: 'the previous one', refinement: 'make it shorter' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.plan'), JSON.stringify(res.body.details));
    assert.strictEqual(chatCalls.length, 0);
});

test('a commit without a plan is refused by name', async () => {
    const before = createCalls.length;
    const res = await post('/agents/wizard/commit', { locale: 'nl' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.plan'), JSON.stringify(res.body.details));
    assert.strictEqual(createCalls.length, before, 'and no agent is created');
});

// ═══ Skills are Enterprise ══════════════════════════════════════════
//
// The wizard itself is Community; the skills it proposes are not. Without
// Skills the plan comes back without them, the model is not shown the library,
// and a commit still creates the agent, just without skills.

const PLAN_WITH_SKILLS = () => ({
    name: 'Invoice Bot',
    description: 'Handles invoices',
    capabilities: ['Read invoices'],
    systemPrompt: 'You handle invoices.',
    enabledIntegrations: [],
    skills: [
        { id: 'lib-1', name: 'Invoices' },
        { id: null, name: 'Dunning letters', instructions: 'Write a polite reminder.' },
    ],
});

test('draft without Skills: no library in the prompt, no skills in the plan', async () => {
    skillsAllowed = false;
    chatImpl = () => ({ content: JSON.stringify(PLAN_WITH_SKILLS()) });
    const res = await post('/agents/wizard/draft', { prompt: 'an invoice agent', locale: 'en' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.plan.skills, [], 'the model proposed skills anyway; they are dropped');
    const system = chatCalls[0].messages[0].content;
    assert.doesNotMatch(system, /Invoices/, 'the skill library is not shown to the model');
    assert.match(system, /Skills are not available in this workspace/);
    assert.strictEqual(gateCalls.length, 1);
    assert.strictEqual(gateCalls[0].userId, 'owner');
    assert.strictEqual(gateCalls[0].orgId, 'orgA');
});

test('draft with Skills: the library is offered and proposals come through', async () => {
    chatImpl = () => ({ content: JSON.stringify(PLAN_WITH_SKILLS()) });
    const res = await post('/agents/wizard/draft', { prompt: 'an invoice agent', locale: 'en' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.plan.skills.length, 2);
    const system = chatCalls[0].messages[0].content;
    assert.match(system, /id="lib-1" name="Invoices"/);
    assert.match(system, /skills: propose 0-5 skills/);
});

test('refine without Skills keeps the preserved skill ids, so an attached skill is not dropped', async () => {
    skillsAllowed = false;
    chatImpl = () => ({ content: JSON.stringify({ ...PLAN_WITH_SKILLS(), name: 'Legal Bot' }) });
    const res = await refine({
        plan: { name: 'Legal Bot', systemPrompt: 'old' },
        current: CURRENT,
        refinement: 'friendlier',
        locale: 'en',
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.deepStrictEqual(res.body.plan.skills, []);
    assert.deepStrictEqual(res.body.preserved.attachedSkillIds, ['s1']);
});

test('commit without Skills creates the agent, creates and attaches no skill, and says so', async () => {
    skillsAllowed = false;
    createCalls.length = 0;
    const res = await post('/agents/wizard/commit', { plan: PLAN_WITH_SKILLS(), locale: 'en' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(createCalls.length, 1, 'the agent is still created');
    assert.deepStrictEqual(createCalls[0][9].attachedSkillIds, [], 'no skill attached, not even an existing one');
    assert.strictEqual(skillCreateCalls.length, 0, 'no skill created');
    assert.deepStrictEqual(res.body.createdSkills, []);
    assert.strictEqual(res.body.skillsSkipped.code, 'feature_locked');
    assert.strictEqual(res.body.skillsSkipped.feature, 'skills');
    assert.match(res.body.skillsSkipped.message, /Enterprise plan/);
    assert.deepStrictEqual(res.body.skillsSkipped.names, ['Invoices', 'Dunning letters']);
    assert.strictEqual(res.body.error, undefined, 'a 200 carries no error key');
});

test('commit with Skills reuses the library skill and creates the new one', async () => {
    createCalls.length = 0;
    const res = await post('/agents/wizard/commit', { plan: PLAN_WITH_SKILLS(), locale: 'en' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(skillCreateCalls.length, 1);
    assert.strictEqual(skillCreateCalls[0].name, 'Dunning letters');
    assert.deepStrictEqual(createCalls[0][9].attachedSkillIds, ['lib-1', 'new-1']);
    assert.strictEqual(res.body.skillsSkipped, undefined);
});

test('a commit that plans no skills never asks the gate', async () => {
    skillsAllowed = false;
    const res = await post('/agents/wizard/commit', { plan: { ...PLAN_WITH_SKILLS(), skills: [] }, locale: 'en' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(gateCalls.length, 0);
    assert.strictEqual(res.body.skillsSkipped, undefined);
});
