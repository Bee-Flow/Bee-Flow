/**
 * execAiStep's OUTPUT CONTRACT — the two ways a schema'd step used to lie.
 *
 * An ai_step with an `outputSchema` promises the rest of the flow a shaped
 * object: every downstream `steps.<id>.output.<field>` is written against it.
 * Two things broke that promise silently, and both are here.
 *
 *   1. THE CEILING. `maxTokens` was hardcoded at 4096 for every tier, so a step
 *      the author had put on `thinking` (32K) or `deep_thinking` (64K) got the
 *      cheapest tier's output budget anyway. A step whose schema asks for a few
 *      markdown tables ran out mid-JSON.
 *
 *   2. THE SILENCE. When the parse then failed, `output` stayed the raw string
 *      and the step reported SUCCESS. Ten downstream references resolved to
 *      undefined, documents rendered empty, and the run was green. A loud
 *      failure is worth more than a green run that produced nothing.
 *
 * The wrap-as-text fallback for an INFERRED schema is deliberately kept: there
 * the author never declared a contract, so guessing is better than failing.
 *
 * Run: node --test --test-force-exit core/automationRunner/execAi.schema.test.js
 */

'use strict';

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../testUtils/stubRequire');

// ── The doubles ────────────────────────────────────────────────────────────

const chatCalls = [];
let chatReply = '{"ok":true}';

const TIERS = {
    fast: { modelId: 'model-fast', maxTokens: 4096 },
    thinking: { modelId: 'model-thinking', maxTokens: 32768 },
    deep_thinking: { modelId: 'model-deep', maxTokens: 64000 },
    // A tier that forgot to declare a ceiling — the fallback has to hold.
    odd: { modelId: 'model-odd' },
};

const restore = installResolveStub({
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
                chatCalls.push({ modelId, options });
                return { content: typeof chatReply === 'function' ? chatReply() : chatReply, usage: {} };
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
        async guardAiInput() { return { blocked: false }; },
        async guardAiOutput(content) { return { content }; },
        restoreForRunState: (v) => v,
        buildPiiSummary() { return null; },
    },
    '../../stores/usageStore': { async logUsage() {} },
    '../../stores/terminationStore': { async logTermination() {} },
});
after(() => restore());

const { execAiStep } = require('./execAi');

const CTX = { userId: 'u1', orgId: 'org1', session: {}, definition: { steps: [] } };

function step(over = {}) {
    return { id: 'ai_1', type: 'ai_step', prompt: 'Do the thing.', inputs: {}, ...over };
}

beforeEach(() => {
    chatCalls.length = 0;
    chatReply = '{"ok":true}';
});

// ── 1. The ceiling follows the tier the author picked ──────────────────────

test('a thinking-tier step gets the thinking tier\'s output budget, not 4096', async () => {
    await execAiStep(step({ modelTier: 'thinking', outputSchema: { ok: 'boolean' } }), CTX, {}, 'live');
    assert.strictEqual(chatCalls.length, 1);
    assert.strictEqual(chatCalls[0].options.maxTokens, 32768);
});

test('deep_thinking gets its own, larger budget', async () => {
    await execAiStep(step({ modelTier: 'deep_thinking', outputSchema: { ok: 'boolean' } }), CTX, {}, 'live');
    assert.strictEqual(chatCalls[0].options.maxTokens, 64000);
});

test('the fast tier is unchanged — this is not a blanket raise', async () => {
    await execAiStep(step({ modelTier: 'fast', outputSchema: { ok: 'boolean' } }), CTX, {}, 'live');
    assert.strictEqual(chatCalls[0].options.maxTokens, 4096);
});

test('a tier with no declared ceiling falls back to 4096 rather than undefined', async () => {
    await execAiStep(step({ modelTier: 'odd', outputSchema: { ok: 'boolean' } }), CTX, {}, 'live');
    assert.strictEqual(chatCalls[0].options.maxTokens, 4096);
});

test('temperature stays pinned — a step must answer the same way twice', async () => {
    await execAiStep(step({ modelTier: 'thinking', outputSchema: { ok: 'boolean' } }), CTX, {}, 'live');
    assert.strictEqual(chatCalls[0].options.temperature, 0.2);
});

// ── 2. A declared schema is a contract, and a broken one is loud ───────────

test('JSON inside a ```json fence is parsed, not passed through as text', async () => {
    chatReply = '```json\n{"titel":"Memorandum","bedrag":1288}\n```';
    const r = await execAiStep(step({ outputSchema: { titel: 'string' } }), CTX, {}, 'live');
    assert.deepStrictEqual(r.output, { titel: 'Memorandum', bedrag: 1288 });
});

test('JSON after a sentence of preamble is still parsed', async () => {
    chatReply = 'Natuurlijk, hier is het resultaat:\n{"titel":"Memorandum"}';
    const r = await execAiStep(step({ outputSchema: { titel: 'string' } }), CTX, {}, 'live');
    assert.deepStrictEqual(r.output, { titel: 'Memorandum' });
});

test('an answer cut off mid-JSON fails the step and says the budget ran out', async () => {
    chatReply = '```json\n{"markdown_wenv":"| Regel | 2025 |\\n| Omzet | 25.367 |","balans":[{"regel":"debit';
    await assert.rejects(
        () => execAiStep(step({ modelTier: 'thinking', outputSchema: { markdown_wenv: 'string' } }), CTX, {}, 'live'),
        (e) => {
            assert.match(e.message, /cut off/i);
            assert.match(e.message, /tier|fewer|shorter/i, 'the message has to say what to do about it');
            assert.strictEqual(e.errorClass, 'ValidationError');
            return true;
        },
    );
});

test('prose where the author declared a schema fails, naming the step', async () => {
    chatReply = 'Ik kan deze cijfers niet lezen, want er ontbreekt een balans.';
    await assert.rejects(
        () => execAiStep(step({ id: 'ai_model', outputSchema: { wenv: 'string' } }), CTX, {}, 'live'),
        (e) => {
            assert.match(e.message, /steps\.ai_model\.output/, 'point at the bindings that would have been empty');
            assert.match(e.message, /Ik kan deze cijfers niet lezen/, 'quote what it actually said');
            return true;
        },
    );
});

test('a JSON ARRAY where an object was promised fails rather than passing an array through', async () => {
    chatReply = '[{"regel":"omzet"},{"regel":"kostprijs"}]';
    await assert.rejects(
        () => execAiStep(step({ outputSchema: { regels: 'array' } }), CTX, {}, 'live'),
        /answered with something else|cut off/i,
    );
});

// ── The inferred-schema fallback is deliberately NOT made loud ─────────────

test('with no declared schema, prose is still wrapped under the inferred field', async () => {
    chatReply = 'Dit is gewoon een stuk tekst.';
    const ctx = {
        ...CTX,
        definition: {
            steps: [
                { id: 'ai_1', type: 'ai_step' },
                { id: 'n1', type: 'notification', title: 't', body: '{{steps.ai_1.output.samenvatting}}' },
            ],
        },
    };
    const r = await execAiStep(step({ outputSchema: undefined }), ctx, {}, 'live');
    assert.strictEqual(typeof r.output, 'object', 'the guess still beats a silent undefined here');
    assert.strictEqual(r.output.samenvatting, 'Dit is gewoon een stuk tekst.');
});

test('with no schema at all, a plain string answer is left alone', async () => {
    chatReply = 'Zomaar tekst.';
    const r = await execAiStep(step(), { ...CTX, definition: { steps: [] } }, {}, 'live');
    assert.strictEqual(r.output, 'Zomaar tekst.');
});
