/**
 * App Studio's AI runtime (acts as the app owner) bills what the provider
 * really reported, cache included.
 *
 * `usageEntry` copied four counts out of `usage` and dropped the cache write
 * and TTL; the non-streaming Claude and Gemini adapters returned the raw
 * provider block (zero tokens to that reader); and `streamChat` looked for the
 * usage under `done.usage` while every adapter puts it flat on the `done`
 * payload, so a streamed app chat was always logged with zero tokens. The
 * adapters here are the REAL ones (only the SDK client is stubbed) behind the
 * real llmClient.
 *
 * Run: node --test appStudio/aiRuntime.usage.test.js
 */
const { test } = require('node:test');
const assert = require('node:assert');
const {
    realClaudeAdapter, realClaudeStreamAdapter, realGeminiAdapter, assertClaudeEntry, assertGeminiEntry,
} = require('../core/providers/usageHarness');

const { preloadStubs } = require('../testUtils/stubRequire');

const usageCalls = [];
preloadStubs(require, {
    '../stores/usageStore': { logUsage: async (entry) => { usageCalls.push(entry); } },
    '../stores/configStore': {
        getConfig: async () => null, setConfig: async () => {}, getSecret: async () => null, setSecret: async () => {},
    },
    '../core/aiAgent': { getAIConfig: async () => ({}), getProviderForModel: async () => ({}) },
    '../core/kb/kbVisibility': { filterKbIdsForUser: async (ids) => ids, filterKbIdsForEmbed: async (ids) => ids },
    '../core/kb/askerContext': { askerContext: async () => ({ orgIds: new Set(), userGroups: [] }) },
    '../core/agentRuntime/knowledgeSearch': { quickKBSearch: async () => [] },
    '../stores/studioAppDataStore': { getAttachment: async () => null },
    '../stores/storageStore': { buildStudioAppAttachmentKey: () => 'k', streamFile: async () => null },
    '../core/documents/attachmentExtractor': {
        extractAttachment: async () => null, formatTextHeader: () => '', formatImagesHeader: () => '', formatFailureNote: () => '',
    },
});

const llmClient = require('../core/llm/llmClient');
const aiRuntime = require('./aiRuntime');

const APP = { id: 'app1', userId: 'owner1', organizationId: 'org1', name: 'Ops' };
const MODEL = { modelId: 'm', options: {} };
const flush = () => new Promise((r) => setImmediate(r));

async function withAdapter(adapter, fn) {
    const orig = llmClient._resolve;
    llmClient._resolve = async () => ({
        apiKey: 'k', baseUrl: '', adapter, providerType: adapter.name, modelId: 'm',
        project: 'p', location: null, serviceAccountKey: null,
    });
    usageCalls.length = 0;
    try { await fn(); await flush(); } finally { llmClient._resolve = orig; }
}

test('runText on Claude: tokens, cache read/write and the 5m/1h split reach the usage row', async () => {
    await withAdapter(realClaudeAdapter([{ text: 'a summary' }]), async () => {
        const out = await aiRuntime.runText(APP, MODEL, { system: 's', user: 'u' });
        assert.strictEqual(out.text, 'a summary');
    });
    assert.strictEqual(usageCalls.length, 1);
    assert.strictEqual(usageCalls[0].source, 'studio_app_ai');
    assert.strictEqual(usageCalls[0].agent_type, 'studio_app');
    assertClaudeEntry(usageCalls[0]);
});

test('runText on Gemini: tokens, thoughts and cache reach the usage row', async () => {
    await withAdapter(realGeminiAdapter([{ text: 'a summary' }]), async () => {
        await aiRuntime.runText(APP, MODEL, { system: 's', user: 'u' });
    });
    assert.strictEqual(usageCalls.length, 1);
    assertGeminiEntry(usageCalls[0]);
});

test('runStructured on Claude: the forced-tool call is billed with its cache', async () => {
    await withAdapter(realClaudeAdapter([{ toolUse: { name: '*', input: { rows: [] } } }]), async () => {
        const out = await aiRuntime.runStructured(APP, MODEL, {
            system: 's', user: 'u', parameters: { type: 'object', properties: { rows: { type: 'array' } } },
        });
        assert.deepStrictEqual(out.structured, { rows: [] });
        assertClaudeEntry(out.usage);
    });
    assert.strictEqual(usageCalls.length, 1);
    assertClaudeEntry(usageCalls[0]);
});

test('streamChat on Claude: the usage on the flat done payload is logged (it used to be zero)', async () => {
    const seen = [];
    await withAdapter(realClaudeStreamAdapter('hello'), async () => {
        await aiRuntime.streamChat(APP, MODEL, { system: 's', messages: [{ role: 'user', content: 'hi' }] },
            (type, data) => seen.push([type, data]));
    });
    assert.ok(seen.some(([t]) => t === 'text'));
    assert.strictEqual(usageCalls.length, 1);
    assert.strictEqual(usageCalls[0].source, 'studio_app_chat');
    assertClaudeEntry(usageCalls[0]);
});

test('streamChat: a stream that reported no usage logs zeros, not a crash', async () => {
    const adapter = { name: 'x', stream: async (_k, _u, _m, _msgs, _o, onEvent) => { onEvent('done', {}); } };
    await withAdapter(adapter, async () => {
        await aiRuntime.streamChat(APP, MODEL, { system: 's', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    });
    assert.strictEqual(usageCalls.length, 1);
    assert.strictEqual(usageCalls[0].prompt_tokens, 0);
});

test('run log: inside a captured step the call lands in the frame with model, tier and tokens; billing unchanged', async () => {
    const { captureStep } = require('./runLog/runTrace.mts');
    let captured = null;
    await withAdapter(realClaudeAdapter([{ text: 'a summary' }]), async () => {
        captured = await captureStep(() => aiRuntime.runText(APP, { ...MODEL, tierName: 'smart' }, { system: 's', user: 'u' }));
    });
    assert.strictEqual(captured.value.text, 'a summary');
    assert.strictEqual(captured.ai.calls, 1);
    assert.strictEqual(captured.ai.model, 'm');
    assert.strictEqual(captured.ai.tier, 'smart');
    assert.strictEqual(captured.ai.promptTokens, usageCalls[0].prompt_tokens);
    assert.strictEqual(captured.ai.completionTokens, usageCalls[0].completion_tokens);
    assert.ok(!JSON.stringify(captured.ai).includes('summary'), 'no answer text in the run log');
    assert.strictEqual(usageCalls.length, 1, 'the usage ledger still gets exactly one row');
});

test('run log: outside a captured step nothing is collected', async () => {
    const { captureStep } = require('./runLog/runTrace.mts');
    await withAdapter(realClaudeAdapter([{ text: 'x' }]), async () => {
        await aiRuntime.runText(APP, MODEL, { system: 's', user: 'u' });
    });
    const empty = await captureStep(async () => 1);
    assert.strictEqual(empty.ai, null);
});

test('the usage entry names the viewer and the run when the runner set them; null outside a scope', () => {
    const { withUsageAttribution } = require('./usageAttribution');
    const { areaOf } = require('../shared/usageAreas');
    const bare = aiRuntime._usageEntry(APP, 'm', {}, Date.now(), 'studio_app_ai');
    assert.strictEqual(bare.user_id, 'owner1', 'the owner pays');
    assert.strictEqual(bare.actor_user_id, null);
    assert.strictEqual(bare.run_id, null);
    const scoped = withUsageAttribution({ actorUserId: 'viewer9', runId: 'run7' },
        () => aiRuntime._usageEntry(APP, 'm', {}, Date.now(), 'studio_app_ai'));
    assert.strictEqual(scoped.user_id, 'owner1');
    assert.strictEqual(scoped.organization_id, 'org1');
    assert.strictEqual(scoped.agent_id, 'app1');
    assert.strictEqual(scoped.actor_user_id, 'viewer9');
    assert.strictEqual(scoped.run_id, 'run7');
    assert.notStrictEqual(areaOf(scoped.source), 'other');
});

test('the attribution survives the awaits of a model call', async () => {
    const { withUsageAttribution } = require('./usageAttribution');
    await withAdapter(realClaudeAdapter([{ text: 'ok' }]), async () => {
        await withUsageAttribution({ actorUserId: 'viewer9', runId: 'run7' }, () => aiRuntime.runText(APP, MODEL, { system: 's', user: 'u' }));
    });
    assert.strictEqual(usageCalls.length, 1);
    assert.strictEqual(usageCalls[0].actor_user_id, 'viewer9');
    assert.strictEqual(usageCalls[0].run_id, 'run7');
});
