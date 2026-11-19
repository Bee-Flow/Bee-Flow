/**
 * Per-app exceptions to the tool block lists hold in every tool loop that asks
 * the gate, as one table: the streaming agent loop
 * (core/agentRuntime/toolRound/piiPolicy.js, whose block list also drives the
 * strip of that tool's result in toolRound/results.js), and the shared gate
 * every other loop binds (core/privacy/toolPiiGate.js toolLoopGate: direct
 * chat, chatWithAgent, swarms, voice, the builder chats, the automation AI
 * step and the cowork / automation runner without an agent, whose own wiring
 * is pinned in core/aiTaskRunner.toolPiiGate.test.js).
 *
 * The real attribution index (core/agentRuntime/toolPolicy/appIndex.js) reads a
 * synthetic tool registry: `outlook` owns outlook_compose, `gmail` owns
 * gmail_compose. The real orgShield classifies, resolves and decides
 * (synthesizeToolPiiPolicy, isBlockedForTool); only the detector is replaced.
 * Every value is synthetic.
 *
 * Run: cd server && node --test core/privacy/toolPiiExemptions.paths.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { useConfigRows } = require('../../testUtils/configRows');
const config = useConfigRows();
const { registerFeatureModules, _clearFeatureModulesForTests } = require('../featureModules');

const SYNTH_EMAIL = 'someone@example.test';
const SYNTH_IBAN = 'XX00TEST0000000000';
const IBAN = 'InternationalBankingAccountNumber';
const TOOLS = { outlook: ['outlook_compose'], gmail: ['gmail_compose'] };

// The registry the attribution index is built from (a feature module), synthetic.
registerFeatureModules({
    'automation/toolRegistry': () => ({
        ALL_TOOL_APPS: Object.keys(TOOLS).map(app => ({ app })),
        loadToolsResult: (entry) => ({ ok: true, tools: TOOLS[entry.app].map(name => ({ function: { name } })) }),
    }),
});
const appIndex = require('../agentRuntime/toolPolicy/appIndex');
appIndex._resetAppIndex();
test.after(() => { appIndex._resetAppIndex(); _clearFeatureModulesForTests('automation/toolRegistry'); config.restore(); });

/** The detector: each planted value is found whenever its category is asked for. */
async function detectPii(text, categories) {
    const entities = [];
    const s = String(text);
    for (const [value, category, label] of [[SYNTH_EMAIL, 'Email', 'Email Address'], [SYNTH_IBAN, IBAN, 'IBAN']]) {
        if (categories.includes(category) && s.includes(value)) entities.push({ text: value, category, label });
    }
    return { hasPii: entities.length > 0, entities };
}

const gate = require('./toolPiiGate');
gate._deps.detectPii = detectPii;
const piiPolicy = require('../agentRuntime/toolRound/piiPolicy');
const agentDeps = { orgShield: () => require('./orgShield'), piiDetection: () => ({ detectPii }) };

function shieldWith(appExemptions) {
    const external = { blockCategories: ['Email', IBAN] };
    if (appExemptions) external.appExemptions = appExemptions;
    return { enabled: true, privacyAction: 'block', toolPiiPolicy: { external, internal: { blockCategories: [] } } };
}

/** The streaming agent loop: may the call go out, and which list strips its result. */
async function agentStream(shield, toolName, args) {
    const rc = {
        dlpShield: shield, webSearchGuardEnabled: false, webSearchGuardPiiCategories: [], onEvent() {},
        userId: 'u1', agent: { organization_id: 'org-1', name: 'Agent' }, agentId: 'a1', conversation: { id: 'c1' },
        modelToUse: 'model-1', messageMetadata: null,
    };
    const policy = piiPolicy.resolveToolPiiPolicy(rc, agentDeps, toolName, args);
    const refusal = policy._blockCats.size > 0
        ? await piiPolicy.checkArgumentPii(rc, agentDeps, { toolCall: { id: 't1' }, toolName, toolArgs: args, policy, _monitorCats: null })
        : null;
    return { refused: !!refusal, resultKeeps: (value, category) => !policy._blockCats.has(category) };
}

/** Every other loop: toolLoopGate's refuse and forModel. */
async function sharedGate(shield, toolName, args) {
    const loop = gate.toolLoopGate({ shield, tag: 'Test' });
    const refusal = await loop.refuse(toolName, args);
    const stripped = await loop.forModel(`${SYNTH_EMAIL} ${SYNTH_IBAN}`, toolName);
    return { refused: !!refusal, resultKeeps: (value) => stripped.includes(value) };
}

const PATHS = { 'agent stream': agentStream, 'toolPiiGate (every other loop)': sharedGate };
const OUTLOOK_MAY_MAIL = { outlook: ['Email'] };

const CASES = [
    // [what, shield, tool, args value, refused?, result keeps the e-mail?, result keeps the IBAN?]
    ['the exempt app receives the released category', shieldWith(OUTLOOK_MAY_MAIL), 'outlook_compose', SYNTH_EMAIL, false, true, false],
    ['the exempt app is still refused what stays blocked', shieldWith(OUTLOOK_MAY_MAIL), 'outlook_compose', SYNTH_IBAN, true, true, false],
    ['another app of the class keeps the whole list', shieldWith(OUTLOOK_MAY_MAIL), 'gmail_compose', SYNTH_EMAIL, true, false, false],
    ['without exceptions nothing changes', shieldWith(null), 'outlook_compose', SYNTH_EMAIL, true, false, false],
    ['an exception that names only a hard category releases nothing', shieldWith({ outlook: ['ApiKeyOrSecret'] }), 'outlook_compose', SYNTH_EMAIL, true, false, false],
];

for (const [pathName, run] of Object.entries(PATHS)) {
    for (const [what, shield, tool, value, refused, keepsEmail, keepsIban] of CASES) {
        test(`${pathName}: ${what}`, async () => {
            const r = await run(shield, tool, { to: value, body: 'hello' });
            assert.equal(r.refused, refused, 'argument check');
            assert.equal(r.resultKeeps(SYNTH_EMAIL, 'Email'), keepsEmail, 'e-mail in the result');
            assert.equal(r.resultKeeps(SYNTH_IBAN, IBAN), keepsIban, 'IBAN in the result');
        });
    }

    test(`${pathName}: an app named in the arguments is not the tool's app`, async () => {
        const r = await run(shieldWith(OUTLOOK_MAY_MAIL), 'gmail_compose', { to: SYNTH_EMAIL, appId: 'outlook', app: 'outlook' });
        assert.equal(r.refused, true);
    });

    test(`${pathName}: a tool with no known app gets no exception (fail closed)`, async () => {
        const shield = { enabled: true, privacyAction: 'block', toolPiiPolicy: {
            external: { blockCategories: [] },
            internal: { blockCategories: ['Email'], appExemptions: { outlook: ['Email'] } },
        } };
        const r = await run(shield, 'notebook_write', { text: SYNTH_EMAIL });
        assert.equal(r.refused, true);
    });
}

// ── The decision and the resolver themselves (orgShield) ──────────────────

const { synthesizeToolPiiPolicy, isBlockedForTool } = require('./orgShield');

test('orgShield: a row without exceptions resolves byte for byte as before', () => {
    const row = { toolPiiPolicy: { external: { blockCategories: ['Person', 'Email'] }, internal: { blockCategories: [IBAN] } } };
    assert.equal(JSON.stringify(synthesizeToolPiiPolicy(row)), JSON.stringify(row.toolPiiPolicy));
    assert.equal(JSON.stringify(synthesizeToolPiiPolicy({})), JSON.stringify({ external: { blockCategories: [] }, internal: { blockCategories: [] } }));
});

test('orgShield: a stored exception is carried, keeping only blocked and non-hard categories', () => {
    const row = { toolPiiPolicy: {
        external: { blockCategories: ['Person', 'Email', IBAN, 'ApiKeyOrSecret'], appExemptions: { outlook: ['Person', 'Email', 'ApiKeyOrSecret', 'Medication'] } },
        internal: { blockCategories: [], appExemptions: { outlook: ['Person'] } },
    } };
    assert.deepEqual(synthesizeToolPiiPolicy(row), {
        external: { blockCategories: ['Person', 'Email', IBAN, 'ApiKeyOrSecret'], appExemptions: { outlook: ['Person', 'Email'] } },
        internal: { blockCategories: [] },
    });
});

test('orgShield: the verdict keeps its shape, and releases only for the exempt app', () => {
    const policy = synthesizeToolPiiPolicy(shieldWith(OUTLOOK_MAY_MAIL));
    assert.deepEqual(isBlockedForTool('outlook_compose', ['Email'], policy, {}), { blocked: false, blockedCategories: [], toolClass: 'external' });
    assert.deepEqual(isBlockedForTool('outlook_compose', ['Email', IBAN], policy, {}), { blocked: true, blockedCategories: [IBAN], toolClass: 'external' });
    assert.deepEqual(isBlockedForTool('gmail_compose', ['Email'], policy, { appId: 'outlook' }), { blocked: true, blockedCategories: ['Email'], toolClass: 'external' });
});
