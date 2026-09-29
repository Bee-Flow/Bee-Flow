/**
 * CW-10 — het privacyschild op de Work-composer (composeCowork).
 *
 * De composer stuurt de ruwe brief van de gebruiker naar het model. Achter de
 * per-org opt-in-vlag (org_cowork_shield_<orgId>, default UIT) loopt die
 * brief nu eerst door dezelfde schildpassage als het agent-pad. De composer
 * houdt zijn eigen faal-envelop: elke schildworp (PII-blok óf fail-closed
 * guard-storing) betekent géén model-call en de fallback-spec — de eigen
 * woorden van de gebruiker terug naar de gebruiker zelf, en de run die
 * daaruit ontstaat wordt bij uitvoering door de runner opnieuw geschild.
 *
 * Gepind:
 *   1. vlag uit → guard niet aangeroepen, spec komt gewoon uit het model;
 *   2. vlag aan → de guard scant exact de brief;
 *   3. PII + blokactie → geen model-call, fallback-spec (composed:false);
 *   4. guard stuk (default fail_closed) → geen model-call, fallback-spec.
 *
 * Zelfde installResolveStub-patroon als de tierContext/usageLog-tests; de
 * schildketen (coworkShieldFlag, orgShield, piiDetection) draait echt, met
 * de guard als lokale HTTP-server.
 *
 * Run: node --test --test-force-exit core/cowork/coworkCompose.coworkShield.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { installResolveStub } = require('../../testUtils/stubRequire');

// ── Muteerbare toestand per scenario ────────────────────
const CONFIGS = {};
let guardEntities = [];
const guardCalls = [];
const chats = [];   // messages-arrays zoals de adapter ze zag
const usage = [];

const MODEL_REPLY = JSON.stringify({
    title: 'Goedemorgen-bericht',
    prompt: 'Schrijf een kort goedemorgenbericht.',
    repeatInterval: 'daily',
    daysOfWeek: null,
    timeOfDay: '08:00',
    runOnce: false,
    agentId: null,
    agentQuote: null,
});

// Eén aiAgent-stub voor beide require-strings: de composer én orgShield
// gebruiken '../aiAgent', piiDetection/validate '../../aiAgent'.
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
    '../llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        TIER_DEFAULTS: { fast: { maxTokens: 1500 } },
    },
    '../aiAgent': aiAgentStub,
    '../providers/index': {
        getAdapter: () => ({
            chat: async (_key, _url, _model, messages) => {
                chats.push(JSON.parse(JSON.stringify(messages)));
                return { content: MODEL_REPLY, usage: { prompt_tokens: 11, completion_tokens: 4 } };
            },
        }),
    },
    '../../stores/usageStore': { logUsage: async (e) => { usage.push(e); } },
    // — leveranciers van de ECHTE schildketen —
    '../../aiAgent': aiAgentStub,              // piiDetection/validate.js
    '../../stores/configStore': configStub,    // coworkShieldFlag + orgShield
    '../../../stores/configStore': configStub, // validate + guardEndpoint
    '../../license/index': {
        resolveTier: async () => 'enterprise',
        tiers: { tierHasFeature: () => true },
    },
    '../../../stores/piiVaultStore': {
        buildSeed: async () => ({ tokenMap: {}, counterFloors: {} }),
    },
    '../../../telemetry/metrics': { recordSidecarCall: () => {} },
});

const { composeCowork } = require('./coworkCompose');
const piiDetection = require('../privacy/piiDetection');

// ── Nep-guard ───────────────────────────────────────────
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

/** Eigen org + eigen brief per scenario (vlagmemo + scancache); endpointcache
 *  en circuit breaker zijn modulestaat en worden expliciet gereset. */
function resetScenario({ orgId, flag, shield, guard }) {
    guardCalls.length = 0; chats.length = 0; usage.length = 0;
    guardEntities = [];
    for (const k of Object.keys(CONFIGS)) delete CONFIGS[k];
    if (flag !== undefined) CONFIGS[`org_cowork_shield_${orgId}`] = flag;
    if (shield) CONFIGS[`org_privacy_shield_${orgId}`] = shield;
    if (guard) CONFIGS.pii_guard_url = guard;
    piiDetection.invalidateGuardEndpointCache();
    piiDetection._resetGuardCircuit();
}

test('vlag uit → guard niet aangeroepen, de spec komt gewoon uit het model', async () => {
    resetScenario({
        orgId: 'corg-uit',
        flag: undefined, // schild wél geconfigureerd, vlag niet — moet niets doen
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    const brief = 'Wens me elke ochtend een goede morgen.';
    const spec = await composeCowork({ brief, userId: 'u1', userOrgId: 'corg-uit' });

    assert.strictEqual(guardCalls.length, 0, 'vlag uit: de guard-client blijft onaangeraakt');
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(chats[0][1].content, brief, 'de brief gaat ongewijzigd naar het model');
    assert.strictEqual(spec.composed, true);
    assert.strictEqual(spec.repeatInterval, 'daily', 'de spec komt uit het model, niet uit de fallback');
});

test('vlag aan → de guard scant exact de brief', async () => {
    resetScenario({
        orgId: 'corg-schoon',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    const brief = 'Vat elke vrijdag de week voor me samen.';
    const spec = await composeCowork({ brief, userId: 'u1', userOrgId: 'corg-schoon' });

    assert.strictEqual(guardCalls.length, 1, 'precies één scan vóór de model-call');
    assert.strictEqual(guardCalls[0].text, brief);
    assert.strictEqual(chats.length, 1);
    assert.strictEqual(spec.composed, true, 'een schone brief componeert gewoon');
});

test('PII + blokactie → geen model-call, fallback-spec met de eigen woorden', async () => {
    resetScenario({
        orgId: 'corg-blok',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: guardUrl,
    });
    guardEntities = [{ text: 'harold@voorbeeld.nl', category: 'Email', confidence: 0.99, label: 'Email' }];
    const brief = 'Mail harold@voorbeeld.nl elke maandag een update.';
    const spec = await composeCowork({ brief, userId: 'u1', userOrgId: 'corg-blok' });

    assert.strictEqual(guardCalls.length, 1);
    assert.strictEqual(chats.length, 0, 'geblokkeerd = de brief bereikt het model nooit');
    assert.strictEqual(spec.composed, false, 'de composer-envelop: fallback, geen fout naar de gebruiker');
    assert.strictEqual(spec.prompt, brief, 'de eigen woorden van de gebruiker, terug naar de gebruiker zelf');
    assert.strictEqual(usage.length, 0, 'geen model-call → geen usage-regel');
});

test('guard stuk (default fail_closed) → geen model-call, fallback-spec', async () => {
    // Geen piiFailureMode → fail_closed, de default van het agent-pad
    // (BFSF-269). De composer vertaalt de privacyUnavailable-worp naar zijn
    // bestaande envelop: geen model-call, de fallback-spec.
    resetScenario({
        orgId: 'corg-dicht',
        flag: true,
        shield: { enabled: true, piiDetectionAction: 'block', piiDetectionConfidenceThreshold: 0.5 },
        guard: 'http://127.0.0.1:1',
    });
    const brief = 'Herinner me elk kwartaal aan de rapportage.';
    const spec = await composeCowork({ brief, userId: 'u1', userOrgId: 'corg-dicht' });

    assert.strictEqual(chats.length, 0, 'fail_closed: geen model-call zolang het schild niet kan scannen');
    assert.strictEqual(spec.composed, false);
    assert.strictEqual(spec.prompt, brief);
    assert.strictEqual(usage.length, 0);
});
