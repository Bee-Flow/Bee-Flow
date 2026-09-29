/**
 * Unit tests — Claude Sonnet 5 (and the adaptive-only family) capability handling.
 *
 * Sonnet 5 is adaptive-thinking-only: it rejects a manual budget_tokens and
 * rejects the temperature/top_p/top_k sampling params (400). These tests lock in
 * that _buildSdkParams never forwards temperature for the adaptive-only family
 * and that budgets are ignored, while legacy 4.6 behaviour is unchanged.
 *
 * Plain assert-based suite (node --test compatible; also runnable directly).
 * Run: node --test core/providers/claudeSonnet5.test.js
 */

const assert = require('assert');
const { test } = require('node:test');
const ClaudeProvider = require('./claude');

const p = new ClaudeProvider();
const MSGS = [{ role: 'user', content: 'hi' }];

test('supportsReasoning includes Sonnet 5 / Opus 4.8 / Fable, excludes Haiku', () => {
    assert.strictEqual(p.supportsReasoning('claude-sonnet-5'), true);
    assert.strictEqual(p.supportsReasoning('claude-opus-4-8'), true);
    assert.strictEqual(p.supportsReasoning('claude-fable-5'), true);
    assert.strictEqual(p.supportsReasoning('claude-sonnet-4-6'), true);
    assert.strictEqual(p.supportsReasoning('claude-haiku-4-5'), false);
});

test('isAdaptiveOnlyReasoning: Sonnet 5 / Opus 4.7-4.8 / Fable yes; Sonnet 4.6 / Opus 4.6 no', () => {
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-sonnet-5'), true);
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-opus-4-7'), true);
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-opus-4-8'), true);
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-fable-5'), true);
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-sonnet-4-6'), false);
    assert.strictEqual(p.isAdaptiveOnlyReasoning('claude-opus-4-6'), false);
});

test('supportsVision includes Sonnet 5 and Fable 5', () => {
    assert.strictEqual(p.supportsVision('claude-sonnet-5'), true);
    assert.strictEqual(p.supportsVision('claude-fable-5'), true);
    assert.strictEqual(p.supportsVision('claude-opus-4-8'), true);
});

test('buildThinking: Sonnet 5 uses adaptive and exposes xhigh', () => {
    const t = p.buildThinking('claude-sonnet-5', { reasoningEffort: 'xhigh' });
    assert.deepStrictEqual(t, { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'xhigh' });
});

test('buildThinking: Sonnet 5 ignores a manual budget (adaptive-only)', () => {
    const t = p.buildThinking('claude-sonnet-5', { budgetTokens: 10000, reasoningEffort: 'high' });
    assert.strictEqual(t.thinking.type, 'adaptive');
    assert.strictEqual(t.thinking.budget_tokens, undefined);
    assert.strictEqual(t.effort, 'high');
});

test('buildThinking: legacy Sonnet 4.6 still honours a manual budget', () => {
    const t = p.buildThinking('claude-sonnet-4-6', { budgetTokens: 10000 });
    assert.deepStrictEqual(t, { thinking: { type: 'enabled', budget_tokens: 10000 } });
});

test('buildThinking: Sonnet 4.6 maps xhigh -> max (no xhigh on legacy)', () => {
    const t = p.buildThinking('claude-sonnet-4-6', { reasoningEffort: 'xhigh' });
    assert.deepStrictEqual(t, { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' });
});

test('_buildSdkParams: Sonnet 5 never forwards temperature, sets adaptive + effort', () => {
    const params = p._buildSdkParams('claude-sonnet-5', MSGS, { temperature: 0.7, reasoningEffort: 'high' });
    assert.strictEqual(params.temperature, undefined);
    assert.strictEqual(params.thinking.type, 'adaptive');
    assert.deepStrictEqual(params.output_config, { effort: 'high' });
});

test('_buildSdkParams: Sonnet 5 omits temperature even when thinking is disabled', () => {
    const params = p._buildSdkParams('claude-sonnet-5', MSGS, { temperature: 0.7, reasoningEffort: 'none' });
    assert.strictEqual(params.temperature, undefined);
    assert.strictEqual(params.thinking, undefined);
});

test('_buildSdkParams: legacy Sonnet 4.6 keeps caller temperature when thinking is off', () => {
    const params = p._buildSdkParams('claude-sonnet-4-6', MSGS, { temperature: 0.5, reasoningEffort: 'none' });
    assert.strictEqual(params.temperature, 0.5);
    assert.strictEqual(params.thinking, undefined);
});
