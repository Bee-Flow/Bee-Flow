/**
 * Driver loop wiring — ported from server/services/securityScanDriver.loop.test.js.
 *
 * Drives the REAL makeDriver().runAgentScan() through a fake unified adapter +
 * provider (injected via host.ai) so we assert, without a live stack, that:
 *   1. the model the tier resolves to is the model that drives the scan (a
 *      non-Claude model is honoured — NO silent Claude fallback);
 *   2. adapter.chat() gets the resolving provider's creds + OpenAI-shaped tools;
 *   3. tool calls are dispatched and their results appended as role:'tool'
 *      messages keyed by tool_call_id, with the assistant turn carrying tool_calls;
 *   4. when the resolved model has no provider, the loop falls back to the
 *      known-good Claude model instead of failing.
 *
 * The module injects store / reportBuilder / host, so this test stubs those
 * directly (no require.cache surgery). NOTE: run against SOURCE, driver.js's
 * __dirname is server/src, so the prompt (packaged at server/prompts) is not
 * co-located and _loadPrompt returns '' — the history therefore leads with the
 * user seed rather than a system message. In the built bundle __dirname is
 * server/ and the system prompt leads; the assertion below accepts both.
 */

const test = require('node:test');
const assert = require('node:assert');

const { makeDriver } = require('../server/src/driver');
const { makeHostMock } = require('./hostMock');

const stubStore = {
    appendProgress: async () => {},
    isCancelRequested: () => false,
    publishEvent: () => {},
};

const stubReportBuilder = {
    aggregate: () => ({ findings: [], severitySummary: { high: 0, medium: 0, low: 0, informational: 0 } }),
    renderReportHtml: () => ({ html: '<html></html>', css: '' }),
    persistReportWebpage: async () => 'wp-1',
    normalizeZap: () => [], normalizeNuclei: () => [], normalizeTestssl: () => [],
};

const fakeTerminal = {
    exec: async (cmd, opts) => {
        if (opts && typeof opts.onChunk === 'function') opts.onChunk({ chunk: 'root\n', stream: 'stdout' });
        return { exitCode: 0, timedOut: false };
    },
};
const fakeRunEngine = async () => ({});

function makeHost({ providerLookup, adapterChat }) {
    return makeHostMock({
        ai: {
            resolveModelForTier: async () => 'devstral-medium-latest',
            getProviderForModel: async (m) => providerLookup(m),
            getAdapter: () => ({ chat: (...a) => adapterChat(...a) }),
        },
        usage: { logUsage: async () => {} },
    });
}

test('honours a non-Claude tier model and dispatches tools (no Claude fallback)', async () => {
    const providerLookup = async (m) => ({
        providerType: 'mistral',
        url: 'http://fake-mistral/v1',
        apiKey: 'mistral-key',
        providerName: 'Mistral',
        model: m,
    });

    const chatCalls = [];
    let turn = 0;
    const adapterChat = (apiKey, baseUrl, model, messages, options) => {
        chatCalls.push({ apiKey, baseUrl, model, options, messages: JSON.parse(JSON.stringify(messages)) });
        turn += 1;
        if (turn === 1) {
            return Promise.resolve({
                content: 'Starting recon.',
                toolCalls: [{ id: 't1', type: 'function', function: { name: 'terminal_exec', arguments: JSON.stringify({ command: 'whoami' }) } }],
                usage: { prompt_tokens: 12, completion_tokens: 4 },
                stopReason: 'tool_use',
            });
        }
        return Promise.resolve({
            content: 'Finished.',
            toolCalls: [{ id: 't2', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'all good', report: '# Assessment' }) } }],
            usage: { prompt_tokens: 20, completion_tokens: 6 },
            stopReason: 'tool_use',
        });
    };

    const host = makeHost({ providerLookup, adapterChat });
    const driver = makeDriver({ store: stubStore, reportBuilder: stubReportBuilder, host });

    const logs = [];
    const result = await driver.runAgentScan({
        scanId: 's1',
        targetUrl: 'https://x.example',
        engines: [{ engine: 'zap' }],
        userId: 'u1',
        organizationId: null,
        modelTier: 'thinking',
        aggression: 'recon',
        maxSteps: 10,
        zap: { baseUrl: 'http://zap', apiKey: 'z' },
        terminal: fakeTerminal,
        runEngine: fakeRunEngine,
        onLine: (l) => logs.push(l),
    });

    // 1. The selected model drove the scan — no fallback to Claude.
    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.reportJson.model, 'devstral-medium-latest');
    assert.ok(!logs.some((l) => /falling back/i.test(l)), 'must not log a Claude fallback');
    assert.ok(logs.some((l) => /using model devstral-medium-latest.*via Mistral/.test(l)), 'should log the resolved provider');

    // 2. adapter.chat got the resolving provider's creds + tools in OpenAI shape.
    assert.strictEqual(chatCalls[0].apiKey, 'mistral-key');
    assert.strictEqual(chatCalls[0].baseUrl, 'http://fake-mistral/v1');
    assert.strictEqual(chatCalls[0].model, 'devstral-medium-latest');
    const tool0 = chatCalls[0].options.tools[0];
    assert.strictEqual(tool0.type, 'function');
    assert.ok(tool0.function.name && tool0.function.parameters, 'tools must be OpenAI function shape');
    assert.strictEqual(chatCalls[0].options.toolChoice, 'auto');

    // 3. The second turn's history carries the assistant tool_calls turn AND the
    //    role:'tool' result keyed by tool_call_id — the shape every adapter needs.
    const msgs2 = chatCalls[1].messages;
    assert.ok(msgs2.some((m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls[0].id === 't1'), 'assistant turn must replay tool_calls');
    assert.ok(msgs2.some((m) => m.role === 'tool' && m.tool_call_id === 't1'), 'tool result must be role:tool keyed by tool_call_id');
    assert.ok(['system', 'user'].includes(msgs2[0].role), 'history leads with the system prompt (packaged) or the user seed (source test)');
    assert.ok(msgs2.some((m) => m.role === 'user' && /authorized security scan of https:\/\/x\.example/.test(m.content)), 'seed user message present');

    // done() ended the loop after exactly two model turns.
    assert.strictEqual(result.reportJson.stepCount, 2);
    assert.strictEqual(result.reportJson.narrative, '# Assessment');
});

test('falls back to the Claude model when the resolved model has no provider', async () => {
    const providerLookup = async (m) => {
        if (m === 'devstral-medium-latest') throw new Error('not served by any configured provider');
        return { providerType: 'claude', url: 'https://api.anthropic.com/v1', apiKey: 'claude-key', providerName: 'Claude', model: m };
    };
    const adapterChat = () => Promise.resolve({
        content: 'Nothing to do.',
        toolCalls: [{ id: 'd1', type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'noop' }) } }],
        usage: {},
        stopReason: 'tool_use',
    });

    const host = makeHost({ providerLookup, adapterChat });
    const driver = makeDriver({ store: stubStore, reportBuilder: stubReportBuilder, host });

    const logs = [];
    const result = await driver.runAgentScan({
        scanId: 's2',
        targetUrl: 'https://x.example',
        engines: [{ engine: 'zap' }],
        userId: 'u1',
        modelTier: 'thinking',
        aggression: 'recon',
        maxSteps: 5,
        zap: { baseUrl: 'http://zap', apiKey: 'z' },
        terminal: fakeTerminal,
        runEngine: fakeRunEngine,
        onLine: (l) => logs.push(l),
    });

    assert.strictEqual(result.status, 'completed');
    assert.strictEqual(result.reportJson.model, 'claude-sonnet-4-6');
    assert.ok(logs.some((l) => /falling back to claude-sonnet-4-6/i.test(l)), 'should log the graceful fallback');
});

test('active-scan aggression clamping: zap_active_scan refused below "active"', async () => {
    // Drive one turn that calls zap_active_scan at aggression 'recon'; the
    // dispatcher must refuse it (gate is independent of the prompt).
    const providerLookup = async (m) => ({ providerType: 'mistral', url: 'http://m/v1', apiKey: 'k', providerName: 'M', model: m });
    const chatCalls = [];
    let turn = 0;
    const adapterChat = (apiKey, baseUrl, model, messages) => {
        chatCalls.push({ messages: JSON.parse(JSON.stringify(messages)) });
        turn += 1;
        if (turn === 1) {
            return Promise.resolve({
                content: '', toolCalls: [{ id: 'a1', type: 'function', function: { name: 'zap_active_scan', arguments: JSON.stringify({ url: 'https://x.example/app' }) } }], usage: {}, stopReason: 'tool_use',
            });
        }
        return Promise.resolve({ content: '', toolCalls: [{ id: 'd2', type: 'function', function: { name: 'done', arguments: '{}' } }], usage: {}, stopReason: 'tool_use' });
    };

    const host = makeHost({ providerLookup, adapterChat });
    const driver = makeDriver({ store: stubStore, reportBuilder: stubReportBuilder, host });

    await driver.runAgentScan({
        scanId: 's3', targetUrl: 'https://x.example', engines: [{ engine: 'zap' }],
        userId: 'u1', modelTier: 'thinking', aggression: 'recon', maxSteps: 5,
        zap: { baseUrl: 'http://zap', apiKey: 'z' }, terminal: fakeTerminal, runEngine: fakeRunEngine,
    });

    // The refusal rides back as the role:'tool' result for the a1 call.
    const secondTurn = chatCalls[1].messages;
    const toolMsg = secondTurn.find((m) => m.role === 'tool' && m.tool_call_id === 'a1');
    assert.ok(toolMsg, 'active-scan tool result present');
    assert.match(toolMsg.content, /active_scan_requires_aggression_active/);
});
