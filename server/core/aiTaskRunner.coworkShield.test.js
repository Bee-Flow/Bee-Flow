/**
 * CW-10: the privacy shield on the NON-agent path of executeTask.
 *
 * The agent runtime scans every turn for PII before anything goes to a model;
 * the plain cowork/automation path sent task.prompt straight into the adapter,
 * while the UI puts a "Privacy shield on" pill next to it. Behind the per-org
 * opt-in flag (org_cowork_shield_<orgId>, default OFF; see
 * core/entitlements/coworkShieldFlag.js) the input now runs through the SAME
 * shield passage as chatWithAgent. Pinned here:
 *
 *   1. flag off → the guard is NOT called and the run is identical to today,
 *      also with a fully configured org shield;
 *   2. flag on → the guard gets to see the task prompt;
 *   3. mask (tokenize) → the adapter sees the token, never the raw value;
 *   4. block → the run fails before any adapter call with 'PII Detected';
 *   5. guard broken → literally the failure mode of the agent path (BFSF-269):
 *      default fail_closed (privacyUnavailable, no model call, no
 *      usage line), fail_open only on an explicit org choice.
 *
 * Really run: coworkShield, coworkShieldFlag, orgShield and the whole piiDetection
 * chain, with the guard as a local HTTP server. Stubbed (the installResolveStub
 * pattern of the tierContext/usageLog tests) are only the DB layer, providers and
 * side matters.
 *
 * Run: node --test --test-force-exit core/aiTaskRunner.coworkShield.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Muteerbare toestand per scenario ────────────────────
const CONFIGS = {};        // wat de gestubde configStore serveert
let currentOrg = null;     // wat resolveEffectiveOrgId oplevert
let guardEntities = [];    // wat de nep-guard "vindt" (offsets worden berekend)
const guardCalls = [];     // request-bodies die de guard bereikten
const chats = [];          // messages-arrays zoals de adapter ze zag
const usage = [];
const notifications = [];
const storeErrors = [];    // err-objecten die markError bereikten
const storeCalls = [];

const fakeStore = {
    markRunning: async () => { storeCalls.push('markRunning'); },
    markCompleted: async () => { storeCalls.push('markCompleted'); },
    markError: async (_id, err) => { storeCalls.push('markError'); storeErrors.push(err); },
    advanceSchedule: async () => { storeCalls.push('advanceSchedule'); },
    updateTask: async () => { storeCalls.push('updateTask'); },
};

// Eén aiAgent-stub voor alle drie de require-strings: de runner
// (getProviderForModel), orgShield en piiDetection/validate (getAIConfig).
const aiAgentStub = {
    getAIConfig: async () => ({ piiDetectionEnabled: false, piiDetectionAction: 'block' }),
    getProviderForModel: async () => ({ providerType: 'stub', url: 'http://stub', apiKey: 'k' }),
};

const configStub = {
    getConfig: async (key) => CONFIGS[key] ?? null,
    getSecret: async () => '',
    getAllConfig: async () => ({}),
};

const restore = installResolveStub({
    // — de runner zelf —
    '../stores/coworkStore': {
        markRunning: async () => {}, markCompleted: async () => {},
        markError: async () => {}, getDueTasks: async () => [],
        updateTask: async () => {}, advanceSchedule: async () => {},
    },
    '../db': { pool: { query: async () => ({ rows: [] }) } },
    '../stores/terminationStore': { logTermination: async () => {} },
    './llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        resolveEffectiveOrgId: async () => currentOrg,
        TIER_DEFAULTS: { fast: {}, thinking: {} },
    },
    './aiAgent': aiAgentStub,
    './providers': {
        getAdapter: () => ({
            chat: async (_key, _url, _model, messages) => {
                chats.push(JSON.parse(JSON.stringify(messages)));
                return { content: 'Klaar.', usage: { prompt_tokens: 2, completion_tokens: 1 } };
            },
        }),
    },
    './integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [] }),
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': { executeTool: async () => 'ok' },
    '../integrations/agentSearchTools': { AGENT_SEARCH_TOOLS: [] },
    '../stores/notificationStore': { createNotification: async (n) => { notifications.push(n); } },
    '../stores/usageStore': { logUsage: async (e) => { usage.push(e); } },
    '../utils/appPaths': { coworkTaskPath: (id) => `/app/cowork/${id}` },
    // — leveranciers van de ECHTE schildketen —
    '../aiAgent': aiAgentStub,     // orgShield.js
    '../../aiAgent': aiAgentStub,  // piiDetection/validate.js
    '../../stores/configStore': configStub,    // coworkShieldFlag + orgShield
    '../../../stores/configStore': configStub, // validate + guardEndpoint
    '../../license/index': {       // orgShield-tierclamps: niets wegknijpen
        resolveTier: async () => 'enterprise',
        tiers: { tierHasFeature: () => true },
    },
    '../../../stores/piiVaultStore': { // vault-seed voor tokenize
        buildSeed: async () => ({ tokenMap: {}, counterFloors: {} }),
    },
    '../../../telemetry/metrics': { recordSidecarCall: () => {} },
});

const { executeTask } = require('./aiTaskRunner');
const piiDetection = require('./privacy/piiDetection');

// ── Nep-guard: registreert bodies, antwoordt met guardEntities ──────────
let guardServer = null;
let guardUrl = null;

before(async () => {
    guardServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            const parsed = JSON.parse(body || '{}');
            guardCalls.push(parsed);
            const entities = guardEntities.map((e) => ({
                ...e,
                offset: String(parsed.text || '').indexOf(e.text),
                length: e.text.length,
            }));
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ hasPii: entities.length > 0, entities }));
        });
    });
    await new Promise((r) => guardServer.listen(0, '127.0.0.1', r));
    guardUrl = `http://127.0.0.1:${guardServer.address().port}`;
});

after(() => {
    if (guardServer) guardServer.close();
    restore();
});

/**
 * Every scenario gets its own org (bypasses the 30s flag memo) and its own
 * prompt text (bypasses the scan cache); the endpoint cache and circuit breaker
 * are explicitly reset because that is module state.
 */
function resetScenario({ orgId, flag, shield, guard }) {
    guardCalls.length = 0; chats.length = 0; usage.length = 0;
    notifications.length = 0; storeErrors.length = 0; storeCalls.length = 0;
    guardEntities = [];
    for (const k of Object.keys(CONFIGS)) delete CONFIGS[k];
    currentOrg = orgId;
    if (flag !== undefined) CONFIGS[`org_cowork_shield_${orgId}`] = flag;
    if (shield) CONFIGS[`org_privacy_shield_${orgId}`] = shield;
    if (guard) CONFIGS.pii_guard_url = guard;
    piiDetection.invalidateGuardEndpointCache();
    piiDetection._resetGuardCircuit();
}

const run = (task) => executeTask(task, { store: fakeStore });

test('vlag uit → de guard wordt niet aangeroepen en de run is identiek', async () => {
    // Shield fully configured AND guard installed, only the flag is
    // missing. Then no shield call may happen at all.
    resetScenario({
        orgId: 'org-uit',
        flag: undefined,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    const prompt = 'Mail harold@voorbeeld.nl het weekoverzicht.';
    await run({ id: 'cw-uit', userId: 'u1', modelTier: 'fast', title: 'T', prompt });

    assert.strictEqual(guardCalls.length, 0, 'vlag uit: de guard-client hoort onaangeraakt te blijven');
    assert.strictEqual(chats.length, 1, 'de adapter wordt gewoon aangeroepen');
    assert.strictEqual(chats[0][1].content, prompt, 'de prompt gaat ongewijzigd door — byte-identiek gedrag');
    assert.ok(storeCalls.includes('markCompleted'));
    assert.strictEqual(storeErrors.length, 0);
});

test('vlag aan → de guard krijgt de taakprompt te zien', async () => {
    resetScenario({
        orgId: 'org-schoon',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    const prompt = 'Vat de planning van deze week samen.';
    await run({ id: 'cw-schoon', userId: 'u1', modelTier: 'fast', title: 'T', prompt });

    assert.strictEqual(guardCalls.length, 1, 'precies één scan vóór de model-call');
    assert.strictEqual(guardCalls[0].text, prompt, 'de guard scant exact de invoer');
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(chats[0][1].content, prompt, 'schone invoer gaat ongewijzigd door');
    assert.ok(storeCalls.includes('markCompleted'));
});

test('maskeren: de adapter ziet de token, nooit de ruwe waarde', async () => {
    resetScenario({
        orgId: 'org-mask',
        flag: { enabled: true },
        shield: { enabled: true, piiDetectionAction: 'tokenize', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    guardEntities = [{ text: 'harold@voorbeeld.nl', category: 'Email', confidence: 0.99, label: 'Email' }];
    const prompt = 'Stuur een update naar harold@voorbeeld.nl over de planning.';
    await run({ id: 'cw-mask', userId: 'u1', modelTier: 'fast', title: 'T', prompt });

    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(chats.length, 1, 'tokenize blokkeert niet — de run loopt door');
    const sent = chats[0][1].content;
    assert.ok(!sent.includes('harold@voorbeeld.nl'), 'de ruwe waarde mag het model nooit bereiken');
    assert.ok(sent.includes('Stuur een update naar'), 'de rest van de prompt blijft staan');
    assert.notStrictEqual(sent, prompt);
    assert.ok(storeCalls.includes('markCompleted'));
});

test('blokkeren: de run faalt vóór enige model-call met PII Detected', async () => {
    resetScenario({
        orgId: 'org-blok',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    guardEntities = [{ text: 'harold@voorbeeld.nl', category: 'Email', confidence: 0.99, label: 'Email' }];
    await run({ id: 'cw-blok', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Mail even naar harold@voorbeeld.nl aub.' });

    assert.strictEqual(chats.length, 0, 'geblokkeerd = de adapter wordt nooit aangeroepen');
    assert.ok(storeCalls.includes('markError'), 'de run faalt zichtbaar');
    assert.match(storeErrors[0].message, /PII Detected/, 'dezelfde blokfout als het agent-pad');
    assert.strictEqual(usage.length, 0, 'niets verbruikt vóór de eerste model-call → geen usage-regel');
    const urgent = notifications.find((n) => n.category === 'urgent');
    assert.ok(urgent && /PII Detected/.test(urgent.message), 'de gebruiker ziet waarom de run faalde');
});

test('guard stuk, default fail_closed → privacyUnavailable, geen model-call', async () => {
    // No piiFailureMode in the shield → the default of the agent path:
    // fail_closed (BFSF-269). Guard installed but unreachable.
    resetScenario({
        orgId: 'org-dicht',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: 'http://127.0.0.1:1',
    });
    await run({ id: 'cw-dicht', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Stel het kwartaaloverzicht op.' });

    assert.strictEqual(chats.length, 0, 'fail_closed: geen model-call zolang het schild niet kan scannen');
    assert.ok(storeCalls.includes('markError'));
    const err = storeErrors[0];
    assert.strictEqual(err.privacyUnavailable, true, 'dezelfde gemarkeerde fout als het agent-pad');
    assert.strictEqual(err.privacyUnavailableKind, 'unavailable');
    assert.match(err.message, /Privacy protection unavailable/);
    assert.ok(!/PII Detected/.test(err.message), 'de onbeschikbaar-blokkade, niet de PII-blokkade');
    assert.strictEqual(usage.length, 0, 'de run strandde vóór de eerste model-call');
});

test('guard stuk, org koos expliciet fail_open → run loopt ongemaskeerd door', async () => {
    resetScenario({
        orgId: 'org-open',
        flag: true,
        shield: {
            enabled: true, piiDetectionAction: 'block',
            piiDetectionConfidenceThreshold: 0.5, piiFailureMode: 'fail_open',
        },
        guard: 'http://127.0.0.1:1',
    });
    const prompt = 'Zet de agenda voor morgen klaar.';
    await run({ id: 'cw-open', userId: 'u1', modelTier: 'fast', title: 'T', prompt });

    assert.strictEqual(chats.length, 1, 'fail_open is een expliciete org-keuze: de run loopt door');
    assert.strictEqual(chats[0][1].content, prompt);
    assert.ok(storeCalls.includes('markCompleted'));
    assert.strictEqual(storeErrors.length, 0);
});
