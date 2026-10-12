/**
 * Een geplande cowork-run rekent zijn verbruik af via HETZELFDE
 * pad als interactieve chats: usageStore.logUsage, met de eigenaar en de al
 * opgeloste effectieve org als attributie. Vóór dit bestond bereikte het
 * niet-agent-pad van executeTask ai_usage_log nooit — nul kosten, geen
 * PAYG-billing, geen org-dashboard: een stille quota-omzeiling.
 *
 * Drie eigenschappen worden hier gepind:
 *   1. de juiste velden (user/org/model/source/tokens) bereiken de sink,
 *      precies één keer per run;
 *   2. een falende usage-log laat de run gewoon slagen — boekhouding is geen
 *      poortwachter;
 *   3. het foutpad rekent de al verbrande tokens alsnog af, en een run die
 *      vóór de eerste model-call strandt logt géén lege regel.
 *
 * Run: node --test --test-force-exit core/aiTaskRunner.usageLog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../testUtils/stubRequire');

// ── Muteerbare toestand per scenario ────────────────────
const logged = [];          // entries die de usage-sink bereikten
let usageSinkDown = false;  // true → logUsage reject (zoals bij een kapotte DB)
let modelForTier = 'model-x';
let script = [];            // adapter.chat-antwoorden; een Error-entry gooit

const storeCalls = [];
const fakeStore = {
    markRunning: async () => { storeCalls.push('markRunning'); },
    markCompleted: async () => { storeCalls.push('markCompleted'); },
    markError: async () => { storeCalls.push('markError'); },
    advanceSchedule: async () => { storeCalls.push('advanceSchedule'); },
    updateTask: async () => { storeCalls.push('updateTask'); },
};

function resetScenario() {
    logged.length = 0;
    storeCalls.length = 0;
    usageSinkDown = false;
    modelForTier = 'model-x';
    script = [];
}

const restore = installResolveStub({
    '../stores/coworkStore': {
        markRunning: async () => {}, markCompleted: async () => {},
        markError: async () => {}, getDueTasks: async () => [],
        updateTask: async () => {}, advanceSchedule: async () => {},
    },
    '../db': { pool: { query: async () => ({ rows: [] }) } },
    '../stores/terminationStore': { logTermination: async () => {} },
    // Tier-resolutie is elders gepind (tierContext-test); hier volstaat een
    // vaste uitkomst zodat de test over de attributie gaat.
    './llm/modelResolver': {
        resolveModelForTier: async () => modelForTier,
        resolveEffectiveOrgId: async () => 'org-eff',
        TIER_DEFAULTS: { fast: {}, thinking: {} },
    },
    './aiAgent': {
        getProviderForModel: async () => ({ providerType: 'stub', url: 'http://stub', apiKey: 'k' }),
    },
    './providers': {
        getAdapter: () => ({
            chat: async () => {
                const step = script.shift();
                if (!step) throw new Error('unexpected adapter call');
                if (step instanceof Error) throw step;
                return step;
            },
        }),
    },
    './integrations/integrationTools': {
        getIntegrationTools: async () => ({ tools: [] }),
        buildToolHint: async () => '',
    },
    './tools/toolDispatcher': { executeTool: async () => 'ok' },
    '../integrations/agentSearchTools': { buildAgentSearchTool: () => null },
    '../stores/notificationStore': { createNotification: async () => {} },
    '../utils/appPaths': { coworkTaskPath: (id) => `/app/cowork/${id}` },
    // DE sink. Async-body draait synchroon tot de eerste await, dus `logged`
    // is gevuld zodra executeTask resolvet; de flush hieronder is extra marge.
    '../stores/usageStore': {
        logUsage: async (entry) => {
            if (usageSinkDown) throw new Error('usage sink down');
            logged.push(entry);
        },
    },
});

const { executeTask } = require('./aiTaskRunner');

const flush = () => new Promise((r) => setImmediate(r));

test('een cowork-run logt verbruik onder eigenaar en effectieve org, precies één keer', async () => {
    resetScenario();
    script = [{ content: 'Klaar.', usage: { prompt_tokens: 7, completion_tokens: 5 } }];

    await executeTask(
        { id: 'cw1', userId: 'u1', modelTier: 'fast', title: 'Ochtendbriefing', prompt: 'Doe iets.' },
        { store: fakeStore },
    );
    await flush();

    assert.strictEqual(logged.length, 1, 'precies één usage-regel per run');
    const entry = logged[0];
    assert.strictEqual(entry.user_id, 'u1');
    assert.strictEqual(entry.organization_id, 'org-eff', 'de al opgeloste effectieve org, niet iets nieuws');
    assert.strictEqual(entry.model, 'model-x');
    assert.strictEqual(entry.source, 'cowork');
    assert.strictEqual(entry.agent_type, 'cowork');
    assert.strictEqual(entry.conversation_id, 'cw1');
    assert.strictEqual(entry.prompt_tokens, 7);
    assert.strictEqual(entry.completion_tokens, 5);
    assert.strictEqual(entry.total_tokens, 12);
    assert.ok(entry.duration_ms >= 0);
    assert.ok(storeCalls.includes('markCompleted'), 'de run slaagt');
    assert.ok(!storeCalls.includes('markError'));
});

test('elke run logt onder source cowork: de runner kent geen tweede soort meer', async () => {
    resetScenario();
    script = [{ content: 'Klaar.', usage: { prompt_tokens: 2, completion_tokens: 1 } }];

    await executeTask(
        { id: 'rt1', userId: 'u2', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' },
        { store: fakeStore },
    );
    await flush();

    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].source, 'cowork');
    assert.strictEqual(logged[0].agent_type, 'cowork');
});

test('een falende usage-log laat de run gewoon slagen', async () => {
    resetScenario();
    usageSinkDown = true;
    script = [{ content: 'Klaar.', usage: { prompt_tokens: 3, completion_tokens: 3 } }];

    await executeTask(
        { id: 'cw2', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' },
        { store: fakeStore },
    );
    await flush();

    assert.strictEqual(logged.length, 0, 'de sink lag eruit');
    assert.ok(storeCalls.includes('markCompleted'), 'boekhouding is geen poortwachter: de run slaagt toch');
    assert.ok(!storeCalls.includes('markError'), 'een log-fout mag nooit als run-fout eindigen');
});

test('een run die halverwege faalt rekent de al verbrande tokens alsnog af', async () => {
    resetScenario();
    script = [
        {
            content: '',
            toolCalls: [{ id: 'tc1', function: { name: 'zoek', arguments: '{}' } }],
            usage: { prompt_tokens: 30, completion_tokens: 4 },
        },
        new Error('provider down'),
    ];

    await executeTask(
        { id: 'cw3', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' },
        { store: fakeStore },
    );
    await flush();

    assert.ok(storeCalls.includes('markError'), 'de run faalt echt');
    assert.strictEqual(logged.length, 1, 'het foutpad logt, en maar één keer');
    assert.strictEqual(logged[0].prompt_tokens, 30);
    assert.strictEqual(logged[0].completion_tokens, 4);
    assert.strictEqual(logged[0].source, 'cowork');
});

test('een run die vóór de eerste model-call strandt logt géén lege regel', async () => {
    resetScenario();
    modelForTier = null; // tier-resolutie mislukt → error vóór enige adapter-call

    await executeTask(
        { id: 'cw4', userId: 'u1', modelTier: 'fast', title: 'T', prompt: 'Doe iets.' },
        { store: fakeStore },
    );
    await flush();

    assert.ok(storeCalls.includes('markError'));
    assert.strictEqual(logged.length, 0, 'niets verbruikt → niets te loggen');
});

test.after(() => restore());
