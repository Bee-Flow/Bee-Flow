/**
 * Auto-tier selection through classify-service: which labels go out, how a
 * score becomes a tier, and that every failure is "no opinion" (null) rather
 * than an error. Transport and endpoint are injected; nothing opens a socket.
 *
 * Run: node --test core/llm/tierClassifierService.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { classifyTierViaService, TIER_LABELS } = require('./tierClassifierService');
const { _resetClassifierState } = require('../classify/classifierClient');

const endpoint = { url: 'http://classify:8300', apiKey: 'k' };
const TIERS = {
    fast: { modelId: 'm-fast' },
    thinking: { modelId: 'm-think' },
    deep_thinking: { modelId: 'm-deep' },
};

/** A fake service that answers the given score per canonical tier. */
function service(byTier, { status = 200, hang = false } = {}) {
    const calls = [];
    const request = async (url, opts) => {
        calls.push({ url, ...opts });
        if (hang) {
            return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason), { once: true }));
        }
        if (status !== 200) return { status, json: { detail: 'nope' } };
        const { texts, labels } = opts.body;
        const scoreOf = (l) => {
            const tier = Object.keys(TIER_LABELS).find((t) => TIER_LABELS[t] === l);
            return byTier[tier] ?? 0.01;
        };
        return {
            status: 200,
            json: { results: texts.map(() => ({ scores: Object.fromEntries(labels.map((l) => [l, scoreOf(l)])) })), labels, engine: 'e1' },
        };
    };
    return { request, calls };
}

test.beforeEach(() => _resetClassifierState());

test('no classifier configured → null without a request', async () => {
    const { request, calls } = service({ fast: 0.9 });
    const out = await classifyTierViaService('hello there friend', TIERS, { endpoint: { url: null, apiKey: '' }, request });
    assert.strictEqual(out, null);
    assert.strictEqual(calls.length, 0);
});

test('sends only the text and the labels of available tiers', async () => {
    const { request, calls } = service({ thinking: 0.9 });
    const out = await classifyTierViaService('explain how a hash map works', TIERS, { endpoint, request });
    assert.strictEqual(out?.tier, 'thinking');
    assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ['labels', 'texts']);
    assert.deepStrictEqual(calls[0].body.texts, ['explain how a hash map works']);
    assert.deepStrictEqual(
        [...calls[0].body.labels].sort(),
        [TIER_LABELS.fast, TIER_LABELS.thinking, TIER_LABELS.deep_thinking].sort(),
    );
});

test('legacy keys serve their canonical tier', async () => {
    const { request } = service({ deep_thinking: 0.95 });
    const out = await classifyTierViaService('prove the halting problem undecidable', { fast: { modelId: 'a' }, pro: { modelId: 'b' } }, { endpoint, request });
    assert.strictEqual(out?.tier, 'pro');
});

test('a low top score is no opinion', async () => {
    const { request } = service({ fast: 0.3, thinking: 0.2 });
    assert.strictEqual(await classifyTierViaService('some text here', TIERS, { endpoint, request }), null);
});

test('a near tie is no opinion', async () => {
    const { request } = service({ fast: 0.8, thinking: 0.78 });
    assert.strictEqual(await classifyTierViaService('some other text', TIERS, { endpoint, request }), null);
});

test('code signals lift a fast verdict to thinking', async () => {
    const { request } = service({ fast: 0.9 });
    const out = await classifyTierViaService('fix this: foo(); bar();', TIERS, { endpoint, request, heuristic: { score: 3, reason: 'code' } });
    assert.strictEqual(out?.tier, 'thinking');
});

test('fewer than two available tiers → null without a request', async () => {
    const { request, calls } = service({ fast: 0.9 });
    assert.strictEqual(await classifyTierViaService('hello world again', { fast: { modelId: 'a' } }, { endpoint, request }), null);
    assert.strictEqual(calls.length, 0);
});

test('a service error is no opinion, never a throw', async () => {
    const { request } = service({}, { status: 500 });
    assert.strictEqual(await classifyTierViaService('anything at all', TIERS, { endpoint, request }), null);
});

test('the deadline returns null fast and never trips the shared breaker', async () => {
    const slow = service({}, { hang: true });
    for (let i = 0; i < 4; i += 1) {
        const started = Date.now();
        assert.strictEqual(await classifyTierViaService(`slow text ${i}`, TIERS, { endpoint, request: slow.request, deadlineMs: 20 }), null);
        assert.ok(Date.now() - started < 500);
    }
    // Four deadline misses in a row: an automation call must still get through.
    const ok = service({ thinking: 0.9 });
    const out = await classifyTierViaService('after the slow ones', TIERS, { endpoint, request: ok.request });
    assert.strictEqual(out?.tier, 'thinking');
    assert.strictEqual(ok.calls.length, 1);
});
