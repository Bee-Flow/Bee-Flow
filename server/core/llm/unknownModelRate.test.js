/**
 * Pure tests — the estimate for a model nothing prices (core/llm/unknownModelRate.js).
 *
 * Proven: the nearest same-family donor wins (version, variant words, dearer on a
 * tie), a donor with a variant word the unknown id lacks is never used, one shared
 * leading word is not a family, the provider-level estimate is a quartile and never
 * the maximum, a donor from another provider is never used when the provider is known,
 * a garbled or absurd donor is ignored (the sanity cap), and a non-chat id (embedding,
 * speech, image) never gets a chat rate.
 *
 * Run: cd server && node --test core/llm/unknownModelRate.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseModelId, prepareCandidates, estimateRate, MAX_INPUT_PER_M, MAX_OUTPUT_PER_M } = require('./unknownModelRate');

const d = (id, vendor, input, output, over = {}) => ({ id, vendor, input, output, cacheRead: null, currency: 'USD', source: 'litellm', ...over });

const POOL = prepareCandidates([
    d('gpt-5', 'openai', 1.25, 10),
    d('gpt-5-mini', 'openai', 0.25, 2),
    d('gpt-5.6-sol', 'openai', 5, 30),
    d('gpt-5.6-sol-mini', 'openai', 1, 6),
    d('gpt-4o', 'openai', 2.5, 10),
    d('gpt-4.1', 'openai', 2, 8),
    d('o3', 'openai', 2, 8),
    d('text-embedding-3-small', 'openai', 0.02, 0),
    d('text-embedding-3-large', 'openai', 0.13, 0),
    d('claude-opus-4-5', 'claude', 5, 25),
    d('claude-opus-4', 'claude', 15, 75),
    d('claude-sonnet-4-5-20250929', 'claude', 3, 15, { cacheRead: 0.3 }),
    d('claude-haiku-4-5', 'claude', 1, 5),
    d('claude-3-5-haiku-20241022', 'claude', 0.8, 4),
    d('qwen3-235b', 'scaleway', 0.75, 2.25, { currency: 'EUR' }),
    d('llama-3.3-70b', 'scaleway', 0.9, 0.9, { currency: 'EUR' }),
    d('gpt-oss-120b', 'scaleway', 0.15, 0.6, { currency: 'EUR' }),
    d('mistral-small-3.2', 'scaleway', 0.15, 0.35, { currency: 'EUR' }),
    d('devstral-small', 'scaleway', 0.2, 0.4, { currency: 'EUR' }),
    d('llama-3.1-8b', 'together', 0.2, 0.2), // other host (vendor null)
]);

const est = (model, vendor) => estimateRate({ model, vendor, pool: POOL });

test('model ids are reduced to words and a version', () => {
    assert.deepStrictEqual(parseModelId('gpt-5.6-sol'), { words: ['gpt', 'sol'], version: [5, 6] });
    assert.deepStrictEqual(parseModelId('claude-3-5-sonnet-20241022'), { words: ['claude', 'sonnet'], version: [3, 5] });
    assert.deepStrictEqual(parseModelId('azure/gpt-4.1-2025-04-14'), { words: ['gpt'], version: [4, 1] });
    assert.deepStrictEqual(parseModelId('claude-sonnet-4-5@20250929'), { words: ['claude', 'sonnet'], version: [4, 5] });
    assert.deepStrictEqual(parseModelId('mistral-large-latest'), { words: ['mistral', 'large'], version: [] });
    assert.deepStrictEqual(parseModelId('qwen/qwen3-235b-a22b-instruct-2507'), { words: ['qwen3', '235b', 'a22b'], version: [] });
});

test('family: the closest version of the same variant is the donor', () => {
    const r = est('gpt-5.7-sol', 'openai');
    assert.strictEqual(r.level, 'family');
    assert.strictEqual(r.donor, 'gpt-5.6-sol');
    assert.strictEqual(r.source, 'estimate:family:gpt-5.6-sol');
    assert.strictEqual(r.input, 5);
    assert.strictEqual(r.output, 30);
});

test('family: a donor with a variant word the unknown id lacks is never used (no mini rate for a flagship)', () => {
    const r = est('gpt-5.7-sol', 'openai');
    assert.notStrictEqual(r.donor, 'gpt-5.6-sol-mini');
    // and the other way round: the unknown "mini" may borrow from its non-mini sibling only if no mini exists
    assert.strictEqual(est('gpt-5.7-sol-mini', 'openai').donor, 'gpt-5.6-sol-mini');
});

test('family: a pure version bump borrows the nearest version of the bare family, cache rate included', () => {
    const r = est('claude-sonnet-4-6', 'claude');
    assert.strictEqual(r.donor, 'claude-sonnet-4-5-20250929');
    assert.strictEqual(r.cacheRead, 0.3);
});

test('family: one shared leading word is not a family when the id has variant words of its own', () => {
    // claude-nova-1 shares only "claude" with the Claude models: provider-level, not an arbitrary sibling
    const r = est('claude-nova-1', 'claude');
    assert.notStrictEqual(r.level, 'family');
});

test('family: a bare "<name>-<n>" id may borrow from the bare family only', () => {
    assert.strictEqual(est('gpt-9', 'openai').donor, 'gpt-5', 'gpt-5 is the nearest bare gpt, never gpt-5-mini');
});

test('a donor of another provider is never used when the provider is known', () => {
    // scaleway serves llama; the cheaper "together" llama is another host
    assert.strictEqual(est('llama-3.3-70b-v2', 'scaleway').donor, 'llama-3.3-70b');
    const viaProvider = est('llama-3.1-8b-v2', 'scaleway');
    assert.strictEqual(viaProvider.level, 'provider', 'only another host has a llama-3.1: Scaleway\'s own quartile, not that host\'s price');
    assert.strictEqual(viaProvider.source, 'estimate:provider:scaleway');
    assert.notStrictEqual(viaProvider.input, 0.2);
    // without a provider the family is looked up across hosts
    assert.strictEqual(est('llama-3.1-8b-v2', null).donor, 'llama-3.1-8b');
});

test('currency follows the donor (Scaleway quotes EUR)', () => {
    assert.strictEqual(est('qwen3-235b-v2', 'scaleway').currency, 'EUR');
});

test('provider level: an upper quartile of that provider\'s chat models, never the maximum', () => {
    const r = est('completely-unrelated', 'openai');
    assert.strictEqual(r.level, 'provider');
    assert.strictEqual(r.source, 'estimate:provider:openai');
    // chat models input [0.25,1.25,1,2,2,2.5,5] sorted -> p75 is 2.5, not the 5 maximum; embeddings are not in the pool
    assert.strictEqual(r.input, 2.5);
    assert.ok(r.output < 30, `output ${r.output} is below the dearest model`);
    assert.strictEqual(r.donor, null);
});

test('provider level needs a pool: a provider with fewer than five chat models yields nothing', () => {
    assert.strictEqual(estimateRate({ model: 'x-9', vendor: 'claude', pool: prepareCandidates([d('claude-opus-4', 'claude', 15, 75)]) }), null);
});

test('azure estimates from Azure and OpenAI donors (a reseller prices like its vendor)', () => {
    assert.strictEqual(est('gpt-5.7-sol', 'azure').donor, 'gpt-5.6-sol');
    assert.strictEqual(est('prod-chat', 'azure').level, 'provider');
});

test('sanity cap: an absurd or garbled donor is not used, so it can never set a rate', () => {
    const poisoned = prepareCandidates([
        d('jais-30b-chat', 'openai', 3200, 9710),
        d('gpt-6-new', 'openai', MAX_INPUT_PER_M + 1, 5),
        d('gpt-6-newer', 'openai', 5, MAX_OUTPUT_PER_M + 1),
        d('gpt-6-nan', 'openai', NaN, 5),
        d('gpt-6-neg', 'openai', -1, 5),
        d('gpt-6-zero', 'openai', 0, 5),
        d('gpt-6-str', 'openai', '5', 5),
        d('x'.repeat(500), 'openai', 1, 1),
        null,
        { id: 7 },
    ]);
    assert.deepStrictEqual(poisoned, []);
    assert.strictEqual(estimateRate({ model: 'gpt-6-newest', vendor: 'openai', pool: poisoned }), null);
    // a donor exactly at the cap is accepted
    const edge = prepareCandidates([d('gpt-7', 'openai', MAX_INPUT_PER_M, MAX_OUTPUT_PER_M)]);
    assert.strictEqual(estimateRate({ model: 'gpt-8', vendor: 'openai', pool: edge }).input, MAX_INPUT_PER_M);
});

test('a non-chat id never gets the provider-level chat estimate, and borrows only from its own kind', () => {
    assert.strictEqual(est('whisper-9', 'openai'), null);
    assert.strictEqual(est('imagen-9', 'google'), null);
    const emb = est('text-embedding-4-small', 'openai');
    assert.strictEqual(emb.donor, 'text-embedding-3-small');
    assert.strictEqual(emb.output, 0);
    // a chat id is not given an embedding donor even if the leading words match
    assert.notStrictEqual((est('text-chat-9', 'openai') || {}).donor, 'text-embedding-3-small');
});

test('hostile ids do not throw and give nothing', () => {
    for (const id of ['', '   ', '/', '@@@', '\u0000', '__proto__', 'constructor', '../../etc/passwd', 'a'.repeat(10_000), null, undefined, 42, {}]) {
        assert.doesNotThrow(() => estimateRate({ model: id, vendor: 'openai', pool: POOL }), String(id).slice(0, 20));
    }
    assert.strictEqual(estimateRate({ model: '', vendor: 'openai', pool: POOL }), null);
    assert.strictEqual(estimateRate({ model: 'gpt-5.7-sol', vendor: 'openai', pool: null }), null);
});

test('the donor id is sanitised before it becomes a source label', () => {
    const pool = prepareCandidates([d('gpt-5 \nevil\u0000"; DROP TABLE x;--', 'openai', 1, 2)]);
    const r = estimateRate({ model: 'gpt-6', vendor: 'openai', pool });
    // the id's words are "gpt-5", "evil", ... — whatever matched, the label has no control or quote characters
    if (r) assert.match(r.source, /^estimate:family:[A-Za-z0-9._:/@+-]+$/);
});
