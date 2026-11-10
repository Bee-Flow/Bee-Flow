/**
 * The output regex guard on the native-adapter path: once it replaced the
 * answer, nothing the stream still sends may follow the replacement.
 *
 * Run: cd server && node --test core/agentRuntime/chatStream/nativeAdapterStream.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const usageStore = require('../../../stores/usageStore');
const { streamNativeAdapterRound } = require('./nativeAdapterStream');

function turnWith(events, { regexConfig } = {}) {
    const seen = [];
    const parts = [];
    return {
        seen,
        args: {
            agent: { name: 'A', model: 'tier:fast' }, agentId: 'a1', userId: 'u1', messageMetadata: {},
            config: { providerType: 'fake', apiKey: 'k', url: 'http://x' }, modelToUse: 'fake-model', conversation: null,
            tools: [], signal: null, onEvent: (type, data) => seen.push([type, data]), regexConfig,
            guardrailViolation: null, _forceFinalAnswer: false,
            effectiveSystemPrompt: 'sys', effectiveVolatilePrompt: '', finalMessages: [{ role: 'user', content: 'hi' }],
            tierSettings: {}, _adapterIsLocal: false, _streamCallStart: Date.now(),
            _thinking: '', _thinkingParts: parts, _thinkingSnapshotFrom: 0,
            _getThinkingPart: (id) => { let p = parts.find((x) => x.id === id); if (!p) { p = { id, text: '' }; parts.push(p); } return p; },
            providerAdapter: { stream: async (_k, _u, _m, _msgs, _o, onEvent) => { for (const [type, data] of events) onEvent(type, data); } },
        },
    };
}

const GUARD = { enabled: true, scope: { agentOutput: true }, rulesWithNames: [{ name: 'codename', pattern: 'Falcon' }] };

test('text and tool calls after an output-guard hit are dropped', async (t) => {
    t.mock.method(usageStore, 'logUsage', async () => {});
    const { seen, args } = turnWith([
        ['text', { text: 'Project Fal' }],
        ['text', { text: 'con budget' }],
        ['text', { text: ' is 5M and launches in May.' }],
        ['tool_use', { id: 't1', name: 'send_mail', input: { body: 'x' } }],
        ['done', { prompt_tokens: 1, completion_tokens: 1 }],
    ], { regexConfig: GUARD });

    const out = await streamNativeAdapterRound(args);

    assert.strictEqual(out.guardrailViolation, 'codename');
    assert.match(out.contentBuffer, /^I apologize/);
    assert.ok(!out.contentBuffer.includes('5M'), 'the rest of the answer is not appended to the replacement');
    assert.deepStrictEqual(out.currentToolCalls, [], 'a tool call after the hit does not run');
    const afterReplace = seen.slice(seen.findIndex(([type]) => type === 'content_replace') + 1);
    assert.deepStrictEqual(afterReplace.filter(([type]) => type === 'content'), [], 'nothing streamed after the replacement');
});

test('without a guard hit the stream passes through unchanged', async (t) => {
    t.mock.method(usageStore, 'logUsage', async () => {});
    const { seen, args } = turnWith([
        ['text', { text: 'Hello ' }],
        ['text', { text: 'world' }],
        ['tool_use', { id: 't1', name: 'lookup', input: { q: 'x' } }],
        ['done', {}],
    ], { regexConfig: GUARD });

    const out = await streamNativeAdapterRound(args);

    assert.strictEqual(out.contentBuffer, 'Hello world');
    assert.strictEqual(out.currentToolCalls.length, 1);
    assert.deepStrictEqual(seen.filter(([type]) => type === 'content').map(([, d]) => d.text), ['Hello ', 'world']);
});
