/**
 * Ook de compose-call zelf is verbruik: één LLM-call per brief, die vóór dit
 * bestond zijn response.usage weggooide. Hier wordt gepind dat hij door
 * dezelfde sink gaat als elke andere call (usageStore.logUsage) met de
 * eigenaar + org als attributie — en dat een falende log de spec niet naar
 * de fallback duwt (boekhouding is geen poortwachter).
 *
 * Run: node --test --test-force-exit core/cowork/coworkCompose.usageLog.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { installResolveStub } = require('../../testUtils/stubRequire');

const logged = [];
let usageSinkDown = false;

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

const restore = installResolveStub({
    '../llm/modelResolver': {
        resolveModelForTier: async () => 'model-x',
        TIER_DEFAULTS: { fast: { maxTokens: 1500 } },
    },
    '../aiAgent': {
        getProviderForModel: async () => ({ providerType: 'stub', url: 'http://stub', apiKey: 'k' }),
    },
    '../providers/index': {
        getAdapter: () => ({
            chat: async () => ({
                content: MODEL_REPLY,
                usage: { prompt_tokens: 11, completion_tokens: 4 },
            }),
        }),
    },
    '../../stores/usageStore': {
        logUsage: async (entry) => {
            if (usageSinkDown) throw new Error('usage sink down');
            logged.push(entry);
        },
    },
});

const { composeCowork } = require('./coworkCompose');

const flush = () => new Promise((r) => setImmediate(r));

test('de compose-call logt zijn verbruik onder eigenaar en org', async () => {
    logged.length = 0;
    usageSinkDown = false;

    const spec = await composeCowork({
        brief: 'Wens me elke ochtend een goede morgen.',
        userId: 'u1',
        userOrgId: 'org-eu',
    });
    await flush();

    assert.strictEqual(spec.composed, true, 'de modelroute is echt gelopen');
    assert.strictEqual(logged.length, 1, 'één usage-regel per compose-call');
    const entry = logged[0];
    assert.strictEqual(entry.user_id, 'u1');
    assert.strictEqual(entry.organization_id, 'org-eu');
    assert.strictEqual(entry.model, 'model-x');
    assert.strictEqual(entry.source, 'cowork_compose');
    assert.strictEqual(entry.prompt_tokens, 11);
    assert.strictEqual(entry.completion_tokens, 4);
    assert.strictEqual(entry.total_tokens, 15);
    assert.ok(entry.duration_ms >= 0);
});

test('een falende usage-log duwt de spec niet naar de fallback', async () => {
    logged.length = 0;
    usageSinkDown = true;

    const spec = await composeCowork({
        brief: 'Wens me elke ochtend een goede morgen.',
        userId: 'u1',
        userOrgId: 'org-eu',
    });
    await flush();

    assert.strictEqual(logged.length, 0);
    assert.strictEqual(spec.composed, true, 'de gecomponeerde spec blijft staan');
    assert.strictEqual(spec.repeatInterval, 'daily', 'de spec komt uit het model, niet uit de fallback');
});

test.after(() => restore());
