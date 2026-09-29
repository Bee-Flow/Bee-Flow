/**
 * Mistral model catalog, effort mapping and the served/regional registries.
 *
 * Run: node --test core/providers/mistralModels.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const m = require('./mistralModels');

beforeEach(() => m._resetMistralRegistries());

test('describe: the -latest aliases describe the model they point to today', () => {
    const small = m.describeMistralModel('mistral-small-latest');
    assert.strictEqual(small.name, 'Mistral Small 4');
    assert.deepStrictEqual([small.vision, small.tools, small.reasoning, small.context], [true, true, true, 256_000]);
    assert.deepStrictEqual(small.efforts, ['none', 'high']);

    const medium = m.describeMistralModel('mistral-medium-latest');
    assert.strictEqual(medium.name, 'Mistral Medium 3.5');
    assert.strictEqual(medium.reasoning, true);

    const large = m.describeMistralModel('mistral-large-latest');
    assert.deepStrictEqual([large.name, large.vision, large.reasoning, large.efforts], ['Mistral Large 3', true, false, null]);
});

test('describe: pinned ids of retired generations keep their own name and limits', () => {
    assert.strictEqual(m.describeMistralModel('mistral-small-2506').name, 'Mistral Small 3.2');
    assert.strictEqual(m.describeMistralModel('mistral-small-2506').reasoning, false);
    assert.strictEqual(m.describeMistralModel('mistral-medium-2508').name, 'Mistral Medium 3.1');
    assert.strictEqual(m.describeMistralModel('mistral-large-2411').vision, false);
    assert.strictEqual(m.describeMistralModel('ministral-8b-2410').context, 128_000);
    assert.strictEqual(m.describeMistralModel('magistral-medium-latest').legacy, true);
});

test('describe: vendor prefixes and case are ignored for the lookup', () => {
    assert.strictEqual(m.describeMistralModel('mistral/Mistral-Small-Latest').name, 'Mistral Small 4');
    assert.strictEqual(m.describeMistralModel('mistralai/ministral-14b-2512').name, 'Ministral 3 14B');
});

test('describe: non-chat models are categorised for the tier picker to leave out', () => {
    assert.strictEqual(m.describeMistralModel('mistral-embed').cat, 'Embedding');
    assert.strictEqual(m.describeMistralModel('codestral-embed-2505').cat, 'Embedding');
    assert.strictEqual(m.describeMistralModel('mistral-ocr-latest').cat, 'OCR');
    assert.strictEqual(m.describeMistralModel('mistral-moderation-2603').cat, 'Moderation');
    assert.strictEqual(m.describeMistralModel('voxtral-mini-latest').cat, 'Audio');
    assert.strictEqual(m.describeMistralModel('codestral-latest').cat, 'Coding');
});

test('describe: an unknown id gets conservative defaults until the live list describes it', () => {
    const before = m.describeMistralModel('mistral-xl-2701');
    assert.deepStrictEqual([before.vision, before.tools, before.reasoning, before.efforts], [false, true, false, null]);

    m.rememberMistralCapabilities('mistral-xl-2701', { vision: true, tools: true, reasoning: true, context: 512_000 });
    const after = m.describeMistralModel('mistral-xl-2701');
    assert.deepStrictEqual([after.vision, after.reasoning, after.context], [true, true, 512_000]);
    assert.deepStrictEqual(after.efforts, ['none', 'high'], 'a reasoning model the file does not know gets the documented pair');
});

test('effort: nearest accepted value, a tie goes to the cheaper one', () => {
    const table = { none: 'none', minimal: 'none', low: 'none', medium: 'high', high: 'high', xhigh: 'high', max: 'high' };
    for (const [asked, sent] of Object.entries(table)) {
        assert.strictEqual(m.normalizeMistralEffort('mistral-small-latest', asked), sent, asked);
    }
    assert.strictEqual(m.normalizeMistralEffort('mistral-small-latest', undefined), undefined);
    assert.strictEqual(m.normalizeMistralEffort('mistral-small-latest', 'bogus'), undefined);
});

test('effort: nothing for models without the switch, Magistral included', () => {
    for (const id of ['mistral-large-latest', 'ministral-3b-latest', 'codestral-latest', 'magistral-small-latest', 'mistral-small-2506']) {
        assert.strictEqual(m.normalizeMistralEffort(id, 'high'), undefined, id);
    }
});

test('cheapest effort for a speed tier: none on a none/high model, null without a switch', () => {
    assert.strictEqual(m.cheapestMistralEffort('mistral-small-latest'), 'none');
    assert.strictEqual(m.cheapestMistralEffort('mistral-medium-latest'), 'none');
    assert.strictEqual(m.cheapestMistralEffort('mistral-large-latest'), null);
});

test('prices: list price with the cached rate, pricing key exact', () => {
    assert.deepStrictEqual(m.getMistralListPrice('mistral-small-latest'), { input: 0.15, output: 0.6, cacheRead: 0.015 });
    assert.deepStrictEqual(m.getMistralListPrice('mistral-medium-3-5'), { input: 1.5, output: 7.5, cacheRead: 0.15 });
    assert.deepStrictEqual(m.getMistralListPrice('ministral-14b-latest'), { input: 0.2, output: 0.2, cacheRead: 0.02 });
    assert.strictEqual(m.getMistralListPrice('mistral-ocr-latest'), null, 'billed per page, not per token');
    assert.strictEqual(m.getMistralListPrice('something-else'), null);
    assert.strictEqual(m.mistralPricingKey('mistral-small-latest'), 'mistral/mistral-small-latest');
});

test('cache read ratio: 10% on the current line-up', () => {
    for (const id of ['mistral-small-latest', 'mistral-medium-latest', 'mistral-large-latest', 'ministral-8b-latest', 'codestral-latest']) {
        assert.ok(Math.abs(m.mistralCacheReadRatio(id) - 0.1) < 1e-9, id);
    }
    assert.strictEqual(m.mistralCacheReadRatio('unknown-model'), null);
});

test('served registry: only registered ids count as served by Mistral', () => {
    assert.strictEqual(m.isMistralServedModel('mistral-small-latest'), false);
    m.registerMistralModel('mistral-small-latest');
    assert.strictEqual(m.isMistralServedModel('mistral-small-latest'), true);
});

test('regional endpoints: api.eu / api.us are regional, the global host is not', () => {
    assert.strictEqual(m.isMistralRegionalUrl('https://api.eu.mistral.ai/v1'), true);
    assert.strictEqual(m.isMistralRegionalUrl('https://api.us.mistral.ai'), true);
    assert.strictEqual(m.isMistralRegionalUrl('https://api.mistral.ai/v1'), false);
    assert.strictEqual(m.isMistralRegionalUrl('https://api.eu.mistral.ai.example.com'), false);
    assert.strictEqual(m.isMistralRegionalUrl(null), false);
});

test('regional uplift follows the flag and can be switched back', () => {
    assert.strictEqual(m.mistralRegionalUplift('mistral-small-latest'), 1);
    m.setMistralRegionalModel('mistral-small-latest', true);
    assert.strictEqual(m.mistralRegionalUplift('mistral-small-latest'), m.MISTRAL_REGIONAL_UPLIFT);
    m.setMistralRegionalModel('mistral-small-latest', false);
    assert.strictEqual(m.mistralRegionalUplift('mistral-small-latest'), 1);
});
