/**
 * Unit tests — forced tool_choice on the Claude models that refuse it.
 *
 * Run: node --test core/providers/claude.forcedToolFallback.test.js
 *
 * Claude Sonnet 5.5, Opus 5.5 and Fable/Mythos 5.1 answer
 * `tool_choice: {type:'tool'|'any'}` with a 400 (`tool_choice: type "tool" and
 * "any" are not supported for this model.`). With claude-sonnet-5-5 as the fast
 * tier that took down every structured-output call that could not go native:
 * the datatable column draft, the form builder, skill and agent test grading
 * and the test suggestions. The adapter now sends `auto` plus an instruction
 * naming the tool on those models, and turns the 400 itself into that same
 * fallback for a model the catalog does not know yet.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');

const MSGS = [
    { role: 'system', content: 'You design tables.' },
    { role: 'user', content: 'Draft the columns.' },
];
const TOOL = {
    type: 'function',
    function: { name: 'emit_columns', description: 'Emit the columns', parameters: { type: 'object', properties: { columns: { type: 'array' } } } },
};
const NAMED = { type: 'function', function: { name: 'emit_columns' } };

function systemText(params) {
    return (params.system || []).map(b => b.text).join('\n');
}

test('Sonnet 5.5: a named forced tool becomes auto plus an instruction naming it', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-5-5', MSGS, { tools: [TOOL], toolChoice: NAMED });
    assert.deepStrictEqual(params.tool_choice, { type: 'auto' });
    assert.match(systemText(params), /`emit_columns` tool exactly once/);
    // The caller's own system prompt stays first, with its cache breakpoint.
    assert.strictEqual(params.system[0].text, 'You design tables.');
    assert.ok(params.system[0].cache_control);
    assert.strictEqual(params.system.at(-1).cache_control, undefined);
});

test('Sonnet 5.5: thinking stays on under the fallback (it cannot be disabled there)', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-5-5', MSGS, { tools: [TOOL], toolChoice: NAMED, maxTokens: 2000 });
    assert.strictEqual(params.thinking?.type, 'adaptive');
    assert.ok(params.output_config?.effort, 'effort must be explicit, not the model default');
    assert.ok(params.max_tokens >= 16384, 'thinking needs headroom before the tool call');
});

test("Opus 5.5 and Fable 5.1: 'required' becomes auto plus a generic tool instruction", () => {
    const p = new ClaudeProvider();
    for (const model of ['claude-opus-5-5', 'claude-fable-5-1']) {
        const params = p._buildSdkParams(model, MSGS, { tools: [TOOL], toolChoice: 'required' });
        assert.deepStrictEqual(params.tool_choice, { type: 'auto' }, model);
        assert.match(systemText(params), /calling one of the provided tools/, model);
    }
});

test('the fallback works without a system prompt of its own', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-5-5', [{ role: 'user', content: 'hi' }], { tools: [TOOL], toolChoice: NAMED });
    assert.strictEqual(params.system.length, 1);
    assert.match(params.system[0].text, /emit_columns/);
});

test('models that accept a forced choice are unchanged: Sonnet 5, Sonnet 4.6, Haiku 4.5, Opus 5', () => {
    const p = new ClaudeProvider();
    for (const model of ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'claude-opus-5']) {
        const params = p._buildSdkParams(model, MSGS, { tools: [TOOL], toolChoice: NAMED });
        assert.deepStrictEqual(params.tool_choice, { type: 'tool', name: 'emit_columns' }, model);
        assert.strictEqual(params.thinking, undefined, `${model}: forced choice still drops thinking`);
        assert.doesNotMatch(systemText(params), /exactly once/, model);
    }
});

test('auto stays auto on Sonnet 5.5 and gets no instruction', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-5-5', MSGS, { tools: [TOOL], toolChoice: 'auto' });
    assert.deepStrictEqual(params.tool_choice, { type: 'auto' });
    assert.doesNotMatch(systemText(params), /exactly once/);
});

test('supportsForcedToolChoice reads the catalog', () => {
    const p = new ClaudeProvider();
    assert.strictEqual(p.supportsForcedToolChoice('claude-sonnet-5-5'), false);
    assert.strictEqual(p.supportsForcedToolChoice('claude-sonnet-5'), true);
});

test('chat(): a 400 on forced tool_choice from a model the catalog thinks accepts it retries once with auto', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    const sent = [];
    p.createClient = () => ({
        messages: {
            create: async (params) => {
                sent.push(params);
                if (params.tool_choice?.type === 'tool') {
                    const err = new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}');
                    Object.assign(err, { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'tool_choice: type "tool" and "any" are not supported for this model.' } } });
                    throw err;
                }
                return {
                    content: [{ type: 'tool_use', id: 't1', name: 'emit_columns', input: { columns: [] } }],
                    stop_reason: 'tool_use',
                    usage: { input_tokens: 5, output_tokens: 5 },
                };
            },
        },
    });
    const res = await p.chat('k', null, 'claude-sonnet-5', MSGS, { tools: [TOOL], toolChoice: NAMED });
    assert.strictEqual(sent.length, 2);
    assert.deepStrictEqual(sent[0].tool_choice, { type: 'tool', name: 'emit_columns' });
    assert.deepStrictEqual(sent[1].tool_choice, { type: 'auto' });
    assert.match(systemText(sent[1]), /emit_columns/);
    assert.strictEqual(res.toolCalls[0].function.name, 'emit_columns');
});

test('chat(): any other 400 is still thrown, and never retried', async () => {
    const p = new ClaudeProvider();
    p._resolveAuth = async () => ({ token: 'x', oauth: false });
    let calls = 0;
    p.createClient = () => ({
        messages: {
            create: async () => {
                calls++;
                throw Object.assign(new Error('400 messages: field required'), { status: 400, error: { message: 'messages: field required' } });
            },
        },
    });
    await assert.rejects(() => p.chat('k', null, 'claude-sonnet-5', MSGS, { tools: [TOOL], toolChoice: NAMED }), /field required/);
    assert.strictEqual(calls, 1);
});
