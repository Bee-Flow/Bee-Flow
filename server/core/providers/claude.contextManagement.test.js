/**
 * Unit tests — Claude-only server-side context management.
 *
 * Run: node --test core/providers/claude.contextManagement.test.js
 *
 * The adapter attaches `context_management` (beta context-management-2025-06-27)
 * to Claude 4+/5 requests with two edits:
 *   - clear_thinking_20251015 (keep: all) whenever thinking is on, so the API
 *     stops dropping older reasoning — its default on Opus 4.6 / Sonnet 4.6 and
 *     earlier is to keep only the last turn;
 *   - clear_tool_uses_20250919 on tool-bearing requests, so heavy tool loops
 *     get trimmed server-side.
 * Order matters: clear_thinking must come first when both are present.
 *
 * Other providers are untouched; our own history/persistence never sees the edit.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const ClaudeProvider = require('./claude');

const TOOLS = [{ function: { name: 'agent_search', description: 'search', parameters: { type: 'object', properties: {} } } }];
const MSGS = [{ role: 'user', content: 'hello' }];

function fakeClient(captured, { failFirst = false } = {}) {
    let calls = 0;
    return {
        messages: {
            create: async (params, requestOptions) => {
                calls++;
                captured.calls.push({ params: JSON.parse(JSON.stringify(params)), requestOptions });
                if (failFirst && calls === 1) {
                    const err = new Error('invalid_request_error');
                    err.status = 400;
                    err.error = { type: 'error', error: { type: 'invalid_request_error', message: 'context_management: Extra inputs are not permitted' } };
                    throw err;
                }
                return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };
            },
        },
    };
}

test('supportsContextEditing matrix', () => {
    const p = new ClaudeProvider();
    assert.strictEqual(p.supportsContextEditing('claude-sonnet-4-6'), true);
    assert.strictEqual(p.supportsContextEditing('claude-opus-4-8'), true);
    assert.strictEqual(p.supportsContextEditing('claude-sonnet-5'), true);
    assert.strictEqual(p.supportsContextEditing('claude-haiku-4-5'), true);
    assert.strictEqual(p.supportsContextEditing('claude-fable-5'), true);
    assert.strictEqual(p.supportsContextEditing('claude-3-5-sonnet-20241022'), false);
    assert.strictEqual(p.supportsContextEditing('claude-3-haiku-20240307'), false);
    assert.strictEqual(p.supportsContextEditing(undefined), false);
});

test('tool-bearing request on Claude 4.6 gets both edits, thinking first', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-4-6', MSGS, { tools: TOOLS });

    assert.ok(params.context_management, 'context_management attached');
    const types = params.context_management.edits.map(e => e.type);
    assert.deepStrictEqual(types, ['clear_thinking_20251015', 'clear_tool_uses_20250919'],
        'clear_thinking must be listed first when combined');

    const toolEdit = params.context_management.edits[1];
    assert.ok(toolEdit.trigger.value > 0 && toolEdit.keep.value > 0 && toolEdit.clear_at_least.value > 0);
});

test('thinking preservation is requested even without tools', () => {
    const p = new ClaudeProvider();
    const params = p._buildSdkParams('claude-sonnet-4-6', MSGS, {});

    assert.ok(params.context_management, 'a tool-free reasoning turn still needs the thinking edit');
    assert.deepStrictEqual(params.context_management.edits, [
        { type: 'clear_thinking_20251015', keep: { type: 'all' } },
    ]);
});

test('thinking off → no thinking edit; tools alone still get theirs', () => {
    const p = new ClaudeProvider();
    assert.strictEqual(
        p._buildSdkParams('claude-sonnet-4-6', MSGS, { reasoningEffort: 'none' }).context_management,
        undefined,
        'no thinking and no tools → nothing to manage');

    const withTools = p._buildSdkParams('claude-sonnet-4-6', MSGS, { tools: TOOLS, reasoningEffort: 'none' });
    assert.deepStrictEqual(withTools.context_management.edits.map(e => e.type), ['clear_tool_uses_20250919']);
});

test('legacy model / _noContextEditing → no context_management', () => {
    const p = new ClaudeProvider();
    assert.strictEqual(p._buildSdkParams('claude-3-5-sonnet-20241022', MSGS, { tools: TOOLS }).context_management, undefined,
        'Claude 3.x rejects the param');
    assert.strictEqual(p._buildSdkParams('claude-sonnet-4-6', MSGS, { tools: TOOLS, _noContextEditing: true }).context_management, undefined,
        'retry-without flag respected');
});

test('chat(): beta header sent alongside the param (API-key mode)', async () => {
    const p = new ClaudeProvider();
    const captured = { calls: [] };
    p.createClient = () => fakeClient(captured);

    await p.chat('sk-ant-api-key', null, 'claude-sonnet-4-6', MSGS, { tools: TOOLS });

    const { params, requestOptions } = captured.calls[0];
    assert.ok(params.context_management);
    assert.strictEqual(requestOptions.headers['anthropic-beta'], 'context-management-2025-06-27');
});

test('chat(): OAuth mode keeps the oauth beta in the merged header', async () => {
    const p = new ClaudeProvider();
    const captured = { calls: [] };
    p.createClient = () => fakeClient(captured);

    await p.chat('sk-ant-oat-subscription-token', null, 'claude-opus-4-8', MSGS, { tools: TOOLS });

    const header = captured.calls[0].requestOptions.headers['anthropic-beta'];
    assert.ok(header.includes('oauth-2025-04-20'), 'per-request header must not clobber the oauth beta');
    assert.ok(header.includes('context-management-2025-06-27'));
});

test('chat(): nothing to manage → no beta header, plain request', async () => {
    const p = new ClaudeProvider();
    const captured = { calls: [] };
    p.createClient = () => fakeClient(captured);

    await p.chat('sk-ant-api-key', null, 'claude-sonnet-4-6', MSGS, { reasoningEffort: 'none' });

    assert.strictEqual(captured.calls[0].params.context_management, undefined);
    assert.strictEqual(captured.calls[0].requestOptions, undefined);
});

test('chat(): context_management rejection retries once without the param', async () => {
    const p = new ClaudeProvider();
    const captured = { calls: [] };
    p.createClient = () => fakeClient(captured, { failFirst: true });

    const result = await p.chat('sk-ant-api-key', null, 'claude-sonnet-4-6', MSGS, { tools: TOOLS });

    assert.strictEqual(captured.calls.length, 2, 'exactly one retry');
    assert.ok(captured.calls[0].params.context_management, 'first attempt carried the param');
    assert.strictEqual(captured.calls[1].params.context_management, undefined, 'retry stripped it');
    assert.strictEqual(captured.calls[1].requestOptions, undefined, 'retry sent no beta header');
    assert.strictEqual(result.content, 'ok');
});

test('chat(): unrelated errors are rethrown, not retried', async () => {
    const p = new ClaudeProvider();
    const captured = { calls: [] };
    p.createClient = () => ({
        messages: {
            create: async (params, requestOptions) => {
                captured.calls.push({ params, requestOptions });
                const err = new Error('overloaded_error');
                err.status = 529;
                throw err;
            },
        },
    });

    await assert.rejects(
        () => p.chat('sk-ant-api-key', null, 'claude-sonnet-4-6', MSGS, { tools: TOOLS }),
        /overloaded_error/
    );
    assert.strictEqual(captured.calls.length, 1, 'no blind retry on unrelated errors');
});
