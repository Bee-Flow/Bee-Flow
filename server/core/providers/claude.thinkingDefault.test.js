// @typecheck
/**
 * Models that think by default (Haiku 5.x, Opus 5) run adaptive thinking when
 * `thinking` is omitted, so `reasoningEffort: 'none'` must send
 * `{type:'disabled'}`. THINKING_ALWAYS models (Opus 5.5, Fable) cannot disable
 * it and keep omitting the field.
 * Run: node --test core/providers/claude.thinkingDefault.test.js
 */
const assert = require('assert');
const { test } = require('node:test');
const ClaudeProvider = require('./claude');
const { describeClaudeModel } = require('./claudeModels');

const p = new ClaudeProvider();
const MSGS = [{ role: 'user', content: 'hi' }];
const TOOLS = [{ name: 'answer', description: 'x', parameters: { type: 'object', properties: {} } }];
const FORCED = { tools: TOOLS, toolChoice: { type: 'function', function: { name: 'answer' } } };

test('haiku 5.5 descriptor: not a reasoning model, but thinks by default', () => {
    const d = describeClaudeModel('claude-haiku-5-5');
    assert.strictEqual(d.reasoning, false);
    assert.strictEqual(d.thinking, 'none');
    assert.strictEqual(d.thinkingOnByDefault, true);
    assert.strictEqual(d.disableThinkingMaxEffort, 'high');
    assert.strictEqual(d.efforts, null);
    assert.strictEqual(d.defaultEffort, null);
});

test('haiku 5.5 with reasoningEffort none sends thinking disabled, no effort', () => {
    const params = p._buildSdkParams('claude-haiku-5-5', MSGS, { reasoningEffort: 'none', maxTokens: 400 });
    assert.deepStrictEqual(params.thinking, { type: 'disabled' });
    assert.strictEqual(params.output_config, undefined);
    assert.strictEqual(params.max_tokens, 400);
    assert.strictEqual(params.temperature, undefined);
    assert.strictEqual(params.context_management?.edits?.some((/** @type {any} */ e) => e.type === 'clear_thinking_20251015') ?? false, false);
});

test('haiku 5.5 without an effort: thinking omitted, max_tokens and output_config untouched', () => {
    const params = p._buildSdkParams('claude-haiku-5-5', MSGS, { maxTokens: 400 });
    assert.strictEqual(params.thinking, undefined);
    assert.strictEqual(params.output_config, undefined);
    assert.strictEqual(params.max_tokens, 400);
});

test('haiku 5.5 with an explicit effort is unchanged (omitted)', () => {
    const params = p._buildSdkParams('claude-haiku-5-5', MSGS, { reasoningEffort: 'high', maxTokens: 400 });
    assert.strictEqual(params.thinking, undefined);
    assert.strictEqual(params.max_tokens, 400);
});

test('haiku 5.5 forced-tool path with none is disabled', () => {
    const params = p._buildSdkParams('claude-haiku-5-5', MSGS, { ...FORCED, reasoningEffort: 'none' });
    assert.deepStrictEqual(params.thinking, { type: 'disabled' });
});

test('opus 5 with none is disabled; its forced-tool path too', () => {
    assert.deepStrictEqual(p._buildSdkParams('claude-opus-5', MSGS, { reasoningEffort: 'none' }).thinking, { type: 'disabled' });
    assert.deepStrictEqual(p._buildSdkParams('claude-opus-5', MSGS, { ...FORCED, reasoningEffort: 'high' }).thinking, { type: 'disabled' });
});

test('opus 5.5 and fable 5.1 cannot disable thinking: none omits the field', () => {
    for (const m of ['claude-opus-5-5', 'claude-fable-5-1']) {
        assert.strictEqual(p._buildSdkParams(m, MSGS, { reasoningEffort: 'none' }).thinking, undefined, m);
    }
});

test('haiku 4.5 is unchanged: no thinking, no reasoning', () => {
    assert.strictEqual(p.supportsReasoning('claude-haiku-4-5'), false);
    assert.strictEqual(p._buildSdkParams('claude-haiku-4-5', MSGS, { reasoningEffort: 'none' }).thinking, undefined);
    assert.strictEqual(p._buildSdkParams('claude-haiku-4-5', MSGS, { reasoningEffort: 'high' }).thinking, undefined);
});

test('haiku 5.5 accepts a forced tool choice: named choice kept, thinking explicitly disabled', () => {
    assert.strictEqual(p.supportsForcedToolChoice('claude-haiku-5-5'), true);
    assert.strictEqual(describeClaudeModel('claude-sonnet-5-5').forcedToolChoice, false);
    assert.strictEqual(describeClaudeModel('claude-opus-5-5').forcedToolChoice, false);
    for (const opts of [{}, { reasoningEffort: 'none' }, { reasoningEffort: 'high' }]) {
        const params = p._buildSdkParams('claude-haiku-5-5', MSGS, { ...FORCED, ...opts });
        assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'answer' });
        assert.deepStrictEqual(params.thinking, { type: 'disabled' });
        assert.strictEqual(params.output_config, undefined);
    }
});
