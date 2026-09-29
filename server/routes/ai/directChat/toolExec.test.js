/**
 * DB-free tests for the direct-chat tool-execution core (H7 extraction).
 *
 * All external dependencies are stubbed via installResolveStub BEFORE the
 * first require of ./toolExec — the real configStore fires initDB() at load,
 * so the stub map is load-bearing, not a convenience. Keys are the require
 * strings exactly as written in toolExec.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const { installResolveStub } = require('../../../testUtils/stubRequire');

// ── Mutable stub holders (reset per test) ───────────────────────────
const dispatcher = { calls: [], impl: async () => ({ ok: 1 }) };
const configHolder = { calls: [], impl: async () => null };
const guardrails = { rows: [] };
const usage = { rows: [] };
const activity = { rows: [] };
const pii = { impl: async () => ({ hasPii: false, entities: [] }) };
const dlp = { map: {} };
const untok = { calls: [] };

function resetStubs() {
    dispatcher.calls = [];
    dispatcher.impl = async () => ({ ok: 1 });
    configHolder.calls = [];
    configHolder.impl = async () => null;
    guardrails.rows = [];
    usage.rows = [];
    activity.rows = [];
    pii.impl = async () => ({ hasPii: false, entities: [] });
    dlp.map = {};
    untok.calls = [];
}

const restore = installResolveStub({
    '../../../core/privacy/guardrails': {
        checkRegexPatterns: (q) => (/BLOCKME/.test(q) ? [{ ruleName: 'test-rule' }] : []),
    },
    '../../../core/tools/toolDisclosure': { LOAD_TOOLS_TOOL_NAME: 'load_tools' },
    '../../../core/tools/sessionSkillRuntime': {
        ACTIVATE_SESSION_SKILL_TOOL_NAME: 'activate_session_skill',
        COMPLETE_SESSION_SKILL_TOOL_NAME: 'complete_session_skill',
    },
    '../../../core/tools/toolDispatcher': {
        executeTool: (name, args, opts) => {
            dispatcher.calls.push({ name, args, opts });
            return dispatcher.impl(name, args, opts);
        },
    },
    '../../../core/http/outboundProbe': {
        runWithProbe: async (fn) => ({ result: await fn(), probe: { probed: true } }),
        markLocal: () => {},
    },
    '../../../core/integrations/integrationToolMap': { resolveIntegration: () => null },
    '../../../integrations/webpageBuilderTools': {
        isBuilderTool: () => false,
        executeBuilderTool: async () => ({ result: {} }),
    },
    // Stubbed for the same reason as its webpage sibling: the real module
    // requires documentStore, which fires initDB() at require time. A DB-free
    // test that pulls that in hangs on pool retries instead of failing.
    '../../../integrations/documentBuilderTools': {
        isDocumentTool: () => false,
        executeDocumentTool: async () => ({}),
    },
    '../../../integrations/webpageDbTools': {
        isDbTool: () => false,
        executeDbTool: async () => ({}),
    },
    '../../../integrations/webpagePlanTool': { executeProposeWebpagePlan: () => ({}) },
    '../../../core/dlp/applyTokenMapToOutbound': {
        untokeniseToolArgs: (args, map) => {
            untok.calls.push({ args, map });
            return args;
        },
    },
    '../../../stores/guardrailEventStore': {
        logGuardrailEvent: (row) => {
            guardrails.rows.push(row);
            return Promise.resolve();
        },
    },
    '../../../stores/configStore': {
        getConfig: (key) => {
            configHolder.calls.push(key);
            return configHolder.impl(key);
        },
    },
    '../../../core/dlp/dlpRunner': {
        getConversationTokenMap: () => dlp.map,
    },
    '../../../core/privacy/piiDetection': {
        detectPii: (...a) => pii.impl(...a),
        restoreTokens: (t) => t,
    },
    '../../../stores/usageStore': {
        logUsage: async (row) => { usage.rows.push(row); },
    },
    '../../../stores/integrationActivityStore': {
        logIntegrationActivity: (row) => {
            activity.rows.push(row);
            return Promise.resolve();
        },
    },
    // core/privacy/orgShield's own config store (the tool block-list gate
    // loads orgShield for classifyToolClass / isBlockedForTool).
    '../../stores/configStore': { getConfig: async () => null, setConfig: async () => true, getAllConfig: async () => ({}) },
});

const {
    executeDirectChatToolCall,
    makeStreamCallback,
    makeTierToolParamsGetter,
    compactToolResultForLLM,
} = require('./toolExec');

test.after(() => restore());
test.beforeEach(() => resetStubs());

// ── Fixtures ─────────────────────────────────────────────────────────
function mkCtx(overrides = {}) {
    const events = [];
    const state = {
        activated: [],
        completed: [],
        rounds: 3,
        model: 'model-1',
        planProposed: false,
        images: [],
        swapCalls: 0,
        completeCalls: [],
    };
    const stubStore = { getConfig: (key) => { configHolder.calls.push(key); return configHolder.impl(key); } };
    const ctx = {
        streamed: false,
        userAuth: { token: 'ua' },
        convId: 'conv-1',
        resolvedTier: 'fast',
        userOrgId: 'org-1',
        userId: 'user-1',
        n8nOrgId: 'org-n8n',
        req: { session: { user: { id: 'user-1' } } },
        regexConfig: null,
        webSearchGuardPiiCategories: null,
        webSearchGuardEnabled: false,
        imageGenSettings: { ig: 1 },
        nanoBananaSettings: { nb: 1 },
        attachments: [],
        sessionSkills: [{ id: 's1' }],
        timezone: 'Europe/Amsterdam',
        webpageBuilderReadSlots: {},
        collectedToolHistory: [],
        getModelId: () => state.model,
        getActivatedSessionSkillIds: () => state.activated,
        setActivatedSessionSkillIds: (ids) => { state.activated = ids; },
        getCompletedSessionSkillIds: () => state.completed,
        getRoundsInCurrentStep: () => state.rounds,
        setRoundsInCurrentStep: (n) => { state.rounds = n; },
        markWebpagePlanProposed: () => { state.planProposed = true; },
        onImageGenerated: (d) => state.images.push(d),
        send: (type, data) => events.push([type, data]),
        applyLoadTools: (args) => ({ loaded: args }),
        swapModelForActiveStage: async () => { state.swapCalls++; },
        handleSessionSkillCompleteResult: (args, res) => state.completeCalls.push([args, res]),
        getTierToolParams: makeTierToolParamsGetter(stubStore),
        ...overrides,
    };
    return { ctx, events, state };
}

function mkToolCall(name, args = {}, id = 'tc-1') {
    return { id, function: { name, arguments: JSON.stringify(args) } };
}

// ── T1: regex guard blocks agent_search ─────────────────────────────
test('T1 regex guard blocks agent_search: exact events, audit row, no dispatch', async () => {
    const { ctx, events } = mkCtx({
        regexConfig: { enabled: true, rulesWithNames: [{ r: 1 }] },
    });
    const out = await executeDirectChatToolCall(mkToolCall('agent_search', { query: 'BLOCKME x' }), ctx);

    assert.deepStrictEqual(out, {
        role: 'tool',
        tool_call_id: 'tc-1',
        content: JSON.stringify({ error: 'Web search blocked — query violates content policy. Please rephrase.' }),
    });
    assert.deepStrictEqual(events, [
        ['tool_start', { name: 'agent_search', args: { query: 'BLOCKME x' } }],
        ['tool_end', { name: 'agent_search', result: '[Web search blocked — query violates content policy]' }],
    ]);
    assert.strictEqual(guardrails.rows.length, 1);
    assert.deepStrictEqual(guardrails.rows[0], {
        organization_id: 'org-1',
        user_id: 'user-1',
        conversation_id: 'conv-1',
        violation_type: 'regex',
        violation_categories: 'test-rule',
        direction: 'input',
        action_taken: 'search_blocked',
        source: 'direct',
        model: 'model-1',
    });
    assert.strictEqual(dispatcher.calls.length, 0);
    assert.strictEqual(usage.rows.length, 0);
    assert.deepStrictEqual(ctx.collectedToolHistory, []);
});

// ── T2: PII guard blocks when webSearchGuardEnabled ─────────────────
test('T2 PII guard blocks agent_search when enabled', async () => {
    pii.impl = async () => ({ hasPii: true, entities: [{ label: 'Email' }, { label: 'Email' }] });
    const { ctx, events } = mkCtx({
        webSearchGuardPiiCategories: ['Person', 'Email'],
        webSearchGuardEnabled: true,
    });
    const out = await executeDirectChatToolCall(mkToolCall('agent_search', { query: 'find a@b.c' }), ctx);

    assert.deepStrictEqual(out, {
        role: 'tool',
        tool_call_id: 'tc-1',
        content: JSON.stringify({ error: 'Web search blocked — query contains sensitive personal information (Email). Please rephrase without PII.' }),
    });
    assert.deepStrictEqual(events[1], ['tool_end', { name: 'agent_search', result: '[Web search blocked — query contains sensitive information (Email)]' }]);
    assert.strictEqual(guardrails.rows.length, 1);
    assert.strictEqual(guardrails.rows[0].violation_type, 'pii');
    assert.strictEqual(guardrails.rows[0].action_taken, 'search_blocked');
    assert.strictEqual(guardrails.rows[0].violation_categories, 'Email');
    assert.strictEqual(dispatcher.calls.length, 0);
});

// ── T3: PII monitor-only when guard disabled ────────────────────────
test('T3 PII monitor-only: audit row pii_detected, dispatch still runs', async () => {
    pii.impl = async () => ({ hasPii: true, entities: [{ label: 'Person' }] });
    const { ctx, events } = mkCtx({
        webSearchGuardPiiCategories: ['Person'],
        webSearchGuardEnabled: false,
    });
    dispatcher.impl = async () => ({ found: true });
    await executeDirectChatToolCall(mkToolCall('agent_search', { query: 'find jan' }), ctx);

    assert.strictEqual(guardrails.rows.length, 1);
    assert.strictEqual(guardrails.rows[0].action_taken, 'pii_detected');
    assert.strictEqual(dispatcher.calls.length, 1);
    assert.deepStrictEqual(events[events.length - 1], ['tool_end', { name: 'agent_search', result: { found: true } }]);
});

// ── T4: DLP untokenise gate ──────────────────────────────────────────
test('T4 untokenise runs for write tools, not for search tools', async () => {
    dlp.map = { '[email_1]': 'a@b.c' };
    const { ctx } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('gmail_send', { to: '[email_1]' }), ctx);
    assert.strictEqual(untok.calls.length, 1);
    assert.deepStrictEqual(untok.calls[0].map, { '[email_1]': 'a@b.c' });

    untok.calls = [];
    await executeDirectChatToolCall(mkToolCall('agent_search', { query: '[email_1]' }), ctx);
    assert.strictEqual(untok.calls.length, 0);
});

// ── T5: tier-tool-params memo ────────────────────────────────────────
test('T5 memo: one getConfig per shared getter; fixedParams flow through', async () => {
    configHolder.impl = async () => ({ fast: { my_tool: { p: 1 } } });
    const { ctx } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('my_tool', {}), ctx);
    await executeDirectChatToolCall(mkToolCall('my_tool', {}, 'tc-2'), ctx);
    assert.deepStrictEqual(configHolder.calls, ['direct_chat_tier_tool_params']);
    assert.strictEqual(dispatcher.calls.length, 2);
    assert.deepStrictEqual(dispatcher.calls[0].opts.fixedParams, { p: 1 });
    assert.deepStrictEqual(dispatcher.calls[1].opts.fixedParams, { p: 1 });
});

test('T5b memo: rejected read warns per call, resets, then retries fresh', async () => {
    configHolder.impl = async () => { throw new Error('cfg down'); };
    const { ctx } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('my_tool', {}), ctx);
    assert.strictEqual(dispatcher.calls.length, 1, 'dispatch still runs on config failure');
    assert.strictEqual(dispatcher.calls[0].opts.fixedParams, null);

    configHolder.impl = async () => ({ fast: { my_tool: { p: 2 } } });
    await executeDirectChatToolCall(mkToolCall('my_tool', {}, 'tc-2'), ctx);
    assert.deepStrictEqual(configHolder.calls, ['direct_chat_tier_tool_params', 'direct_chat_tier_tool_params']);
    assert.deepStrictEqual(dispatcher.calls[1].opts.fixedParams, { p: 2 });
});

// ── T6: D3 drift — per-variant tool-message encoding ────────────────
test('T6 string result: raw passthrough non-streamed, parsed+wrapped streamed', async () => {
    dispatcher.impl = async () => 'hello result';
    const a = await executeDirectChatToolCall(mkToolCall('my_tool'), mkCtx({ streamed: false }).ctx);
    assert.strictEqual(a.content, 'hello result');
    // The ENCODING still differs per variant. The tool's name no longer does:
    // it used to be absent here, and everything downstream that asks a result
    // what tool made it got undefined on this branch.
    assert.strictEqual(a._toolName, 'my_tool');
    assert.strictEqual(a._toolResult, 'hello result');

    const b = await executeDirectChatToolCall(mkToolCall('my_tool'), mkCtx({ streamed: true }).ctx);
    assert.strictEqual(b.content, JSON.stringify({ result: 'hello result' }));
    assert.strictEqual(b._toolName, 'my_tool');

    dispatcher.impl = async () => '{"a":1}';
    const c = await executeDirectChatToolCall(mkToolCall('my_tool'), mkCtx({ streamed: true }).ctx);
    assert.strictEqual(c.content, '{"a":1}');

    dispatcher.impl = async () => ({ ok: 1 });
    const d = await executeDirectChatToolCall(mkToolCall('my_tool'), mkCtx({ streamed: false }).ctx);
    const e = await executeDirectChatToolCall(mkToolCall('my_tool'), mkCtx({ streamed: true }).ctx);
    assert.strictEqual(d.content, JSON.stringify({ ok: 1 }));
    assert.strictEqual(e.content, JSON.stringify({ ok: 1 }));
});

test('T6b toolName fallback (D1): non-streamed falls back to toolCall.name, streamed does not', async () => {
    const bare = { id: 'tc-1', name: 'legacy_tool', function: {} };
    const { ctx, events } = mkCtx({ streamed: false });
    await executeDirectChatToolCall(bare, ctx);
    assert.strictEqual(events[0][1].name, 'legacy_tool');

    const { ctx: ctx2, events: events2 } = mkCtx({ streamed: true });
    await executeDirectChatToolCall(bare, ctx2);
    assert.strictEqual(events2[0][1].name, undefined);
});

// ── T7: SSE order, history, usage row ────────────────────────────────
test('T7 normal dispatch: events, history entry, usage row', async () => {
    dispatcher.impl = async () => ({ ok: 1 });
    const { ctx, events } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('my_tool', { a: 1 }), ctx);

    assert.deepStrictEqual(events, [
        ['tool_start', { name: 'my_tool', args: { a: 1 } }],
        ['tool_end', { name: 'my_tool', result: { ok: 1 } }],
    ]);
    assert.deepStrictEqual(ctx.collectedToolHistory, [{
        name: 'my_tool',
        args: { a: 1 },
        status: 'done',
        resultPreview: JSON.stringify({ ok: 1 }),
    }]);
    assert.deepStrictEqual(usage.rows, [{
        user_id: 'user-1',
        agent_name: 'direct-chat',
        agent_type: 'chat',
        model: 'model-1',
        tool_name: 'my_tool',
        source: 'direct_chat',
        organization_id: 'org-1',
        conversation_id: 'conv-1',
    }]);
    // dispatch received the full option surface
    const opts = dispatcher.calls[0].opts;
    assert.strictEqual(opts.userId, 'user-1');
    assert.strictEqual(opts.userAuth.token, 'ua');
    assert.strictEqual(opts.orgId, 'org-n8n');
    assert.strictEqual(opts.timezone, 'Europe/Amsterdam');
    assert.strictEqual(opts.terminalCtx.agentId, 'user-user-1');
    assert.strictEqual(opts.terminalCtx.containerKey, 'direct-conv-1');
});

// ── T8: session-skill activation ─────────────────────────────────────
test('T8 activation: dedup ids, rounds reset, SSE payload, model swap awaited', async () => {
    dispatcher.impl = async () => ({ activatedSkillIds: ['a', 'a', 'b'] });
    const { ctx, events, state } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('activate_session_skill', {}), ctx);

    assert.deepStrictEqual(state.activated, ['a', 'b']);
    assert.strictEqual(state.rounds, 0);
    assert.strictEqual(state.swapCalls, 1);
    const skillEvt = events.find(([t]) => t === 'session_skills_updated');
    assert.deepStrictEqual(skillEvt[1], {
        skills: [{ id: 's1' }],
        activatedSkillIds: ['a', 'b'],
        completedSkillIds: [],
    });
});

test('T8b completion routes through handleSessionSkillCompleteResult', async () => {
    dispatcher.impl = async () => ({ done: true });
    const { ctx, state } = mkCtx();
    await executeDirectChatToolCall(mkToolCall('complete_session_skill', { skillId: 's1' }), ctx);
    assert.deepStrictEqual(state.completeCalls, [[{ skillId: 's1' }, { done: true }]]);
});

// ── T9: dispatch error path ──────────────────────────────────────────
test('T9 dispatch throw: no rethrow, error result in tool_end and message', async () => {
    dispatcher.impl = async () => { throw new Error('boom'); };
    const { ctx, events } = mkCtx();
    const out = await executeDirectChatToolCall(mkToolCall('my_tool'), ctx);
    assert.deepStrictEqual(events[1], ['tool_end', { name: 'my_tool', result: { error: 'boom' } }]);
    assert.strictEqual(out.content, JSON.stringify({ error: 'boom' }));
});

// ── T10: live modelId getter ─────────────────────────────────────────
test('T10 modelId is read live (swapModelForActiveStage contract)', async () => {
    const { ctx, state } = mkCtx();
    dispatcher.impl = async () => { state.model = 'model-2'; return { ok: 1 }; };
    await executeDirectChatToolCall(mkToolCall('my_tool'), ctx);
    assert.strictEqual(usage.rows[0].model, 'model-2');
});

// ── makeStreamCallback ───────────────────────────────────────────────
function mkStreamOpts(overrides = {}) {
    const rec = {
        sends: [],
        content: '',
        thinking: '',
        streamed: [],
        parts: [],
        toolCalls: [],
        lastId: null,
        usage: null,
        images: [],
        order: [],
    };
    const opts = {
        send: (t, d) => { rec.sends.push([t, d]); },
        streamContent: (t) => { rec.order.push('stream'); rec.streamed.push(t); },
        getThinkingPart: (partId) => {
            let part = rec.parts.find(p => p.id === partId);
            if (!part) { part = { id: partId, text: '', startedAt: 1, endedAt: null }; rec.parts.push(part); }
            return part;
        },
        maybeStreamNotebook: () => {},
        streamUntok: { restore: (t) => `R(${t})` },
        isMuted: () => false,
        appendContent: (t) => { rec.order.push('append'); rec.content += t; },
        appendThinking: (t) => { rec.thinking += t; },
        getThinkingParts: () => rec.parts,
        pushToolCall: (tc) => rec.toolCalls.push(tc),
        acceptToolCallEvents: false,
        onImage: null,
        onUsage: null,
        setLastResponseId: (id) => { rec.lastId = id; },
        responseIdLog: '[test] responseId:',
        ...overrides,
    };
    return { opts, rec };
}

test('T11 text: append before streamContent; mute drops both', () => {
    const { opts, rec } = mkStreamOpts();
    const cb = makeStreamCallback(opts);
    cb('text', { text: 'hi' });
    assert.strictEqual(rec.content, 'hi');
    assert.deepStrictEqual(rec.streamed, ['hi']);
    assert.deepStrictEqual(rec.order, ['append', 'stream']);

    const muted = mkStreamOpts({ isMuted: () => true });
    makeStreamCallback(muted.opts)('text', { text: 'nope' });
    assert.strictEqual(muted.rec.content, '');
    assert.deepStrictEqual(muted.rec.streamed, []);
});

test('T12 thinking: partId path + implicit auto-part + untokenised send', () => {
    const { opts, rec } = mkStreamOpts();
    const cb = makeStreamCallback(opts);
    cb('thinking', { text: 'aa', partId: 'p1' });
    assert.strictEqual(rec.parts[0].text, 'aa');
    assert.deepStrictEqual(rec.sends[0], ['thinking', { text: 'R(aa)', partId: 'p1' }]);

    // implicit block: no partId — appended to the live array with auto-N id
    const imp = mkStreamOpts();
    const cb2 = makeStreamCallback(imp.opts);
    cb2('thinking', { text: 'x' });
    cb2('thinking', { text: 'y' });
    assert.strictEqual(imp.rec.parts.length, 1);
    assert.strictEqual(imp.rec.parts[0].id, 'auto-0');
    assert.strictEqual(imp.rec.parts[0].text, 'xy');
    assert.strictEqual(imp.rec.thinking, 'xy');
});

test('T13 thinking_start/signature/stop mutate the part', () => {
    const { opts, rec } = mkStreamOpts();
    const cb = makeStreamCallback(opts);
    cb('thinking_start', { partId: 'p1', redacted: true });
    assert.strictEqual(rec.parts[0].redacted, true);
    assert.deepStrictEqual(rec.sends[0], ['thinking_start', { partId: 'p1', redacted: true }]);
    cb('thinking_signature', { partId: 'p1', signature: 'sig' });
    assert.strictEqual(rec.parts[0].signature, 'sig');
    assert.strictEqual(rec.sends.length, 1, 'signature never reaches SSE');
    cb('thinking_stop', { partId: 'p1' });
    assert.ok(rec.parts[0].endedAt);
    assert.deepStrictEqual(rec.sends[1], ['thinking_stop', { partId: 'p1', redacted: undefined }]);
});

test('T14 tool_use normalization + tool_call gating', () => {
    const { opts, rec } = mkStreamOpts();
    const cb = makeStreamCallback(opts);
    cb('tool_use', { id: 'id-1', name: 'x', input: { a: 1 }, thought_signature: 'ts' });
    assert.deepStrictEqual(rec.toolCalls[0], {
        id: 'id-1',
        type: 'function',
        function: { name: 'x', arguments: '{"a":1}' },
        _thought_signature: 'ts',
    });
    cb('tool_use', { name: 'y' });
    assert.match(rec.toolCalls[1].id, /^call_\d+_/);
    assert.strictEqual(rec.toolCalls[1].function.arguments, '{}');
    assert.strictEqual(rec.toolCalls[1]._thought_signature, undefined);

    // tool_call ignored on the primary stream, accepted on the follow-up
    cb('tool_call', { raw: 1 });
    assert.strictEqual(rec.toolCalls.length, 2);
    const follow = mkStreamOpts({ acceptToolCallEvents: true });
    makeStreamCallback(follow.opts)('tool_call', { raw: 1 });
    assert.deepStrictEqual(follow.rec.toolCalls, [{ raw: 1 }]);
});

test('T15 image + done gating (onImage/onUsage/responseId)', () => {
    const { opts, rec } = mkStreamOpts();
    const cb = makeStreamCallback(opts);
    cb('image', { data: 'zzz' });   // onImage null → dropped (follow-up behavior)
    assert.deepStrictEqual(rec.sends, []);

    const withImg = mkStreamOpts({ onImage: (d) => withImg.rec.images.push(d) });
    makeStreamCallback(withImg.opts)('image', { data: 'zzz', mimeType: 'image/png' });
    assert.deepStrictEqual(withImg.rec.images, [{ data: 'zzz', mimeType: 'image/png' }]);

    cb('done', { prompt_tokens: 5 });
    assert.strictEqual(rec.usage, null, 'onUsage null → usage not captured');
    assert.strictEqual(rec.lastId, null);

    const prim = mkStreamOpts({ onUsage: (d) => { prim.rec.usage = d; } });
    const cbp = makeStreamCallback(prim.opts);
    cbp('done', { prompt_tokens: 5, responseId: 'resp-1' });
    assert.deepStrictEqual(prim.rec.usage, { prompt_tokens: 5, responseId: 'resp-1' });
    assert.strictEqual(prim.rec.lastId, 'resp-1');

    cbp('error', { error: 'x' });
    assert.deepStrictEqual(prim.rec.sends.at(-1), ['error', { error: 'x' }]);
});

test('T16 live rebinding: retry-style array swaps are observed', () => {
    let parts = [];
    let calls = [];
    const { opts } = mkStreamOpts({
        getThinkingParts: () => parts,
        pushToolCall: (tc) => calls.push(tc),
    });
    const cb = makeStreamCallback(opts);
    cb('thinking', { text: 'a' });
    cb('tool_use', { id: 'i1', name: 'x' });
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(calls.length, 1);

    // simulate the stream-retry reset: thinkingParts = []; streamToolCalls = [];
    parts = [];
    calls = [];
    cb('thinking', { text: 'b' });
    cb('tool_use', { id: 'i2', name: 'y' });
    assert.strictEqual(parts.length, 1);
    assert.strictEqual(parts[0].text, 'b');
    assert.deepStrictEqual(calls.map(c => c.id), ['i2']);
});

// ── compactToolResultForLLM pins ─────────────────────────────────────
test('compactToolResultForLLM: workspace_update + nbWriteFailed shapes', () => {
    assert.strictEqual(compactToolResultForLLM('s'), 's');
    assert.deepStrictEqual(
        compactToolResultForLLM({ _action: 'workspace_update', message: 'm', content: 'big' }),
        { action: 'notebook_updated', message: 'm' },
    );
    assert.deepStrictEqual(
        compactToolResultForLLM({ _nbWriteFailed: true, _revertContent: 'big', keep: 1 }),
        { keep: 1 },
    );
});

// ── Audio carries the tool that made it, on both branches ───────────
// The chat titles a clip from its source: a name containing 'tts' is speech,
// 'sfx' is a sound effect, anything else is music. A missing source therefore
// does not read as "unknown" on screen — it reads as "AI Generated Music",
// confidently and wrongly, which is why this is pinned per branch.
test('T7 a result knows its tool whether or not the round streamed', async () => {
    dispatcher.impl = async () => ({ audioUrl: 'https://example.test/a.mp3' });

    const plain = await executeDirectChatToolCall(mkToolCall('elevenlabs_tts'), mkCtx({ streamed: false }).ctx);
    assert.strictEqual(plain._toolName, 'elevenlabs_tts');

    const streamed = await executeDirectChatToolCall(mkToolCall('elevenlabs_tts'), mkCtx({ streamed: true }).ctx);
    assert.strictEqual(streamed._toolName, 'elevenlabs_tts');
});

// ── BFSF-354: the Privacy Shield tool block lists in direct chat ─────
// The agent tool loop honoured "Outside tools" / "Own server"; direct chat
// ignored both. Detection is injected into the real gate; synthetic data.
const toolPiiGate = require('../../../core/privacy/toolPiiGate');
const SYNTH_EMAIL = 'someone@example.test';
const OWN_SERVER_EMAIL = {
    enabled: true,
    privacyAction: 'redact',
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: ['Email'] } },
};
const emailDetector = () => async (text, categories) => {
    const i = String(text).indexOf(SYNTH_EMAIL);
    if (i < 0 || !categories.includes('Email')) return { hasPii: false, entities: [] };
    return { hasPii: true, entities: [{ text: SYNTH_EMAIL, category: 'Email', label: 'Email Address', offset: i, length: SYNTH_EMAIL.length }] };
};

test('BFSF-354 an own-server block category in the arguments refuses the tool', async () => {
    toolPiiGate._deps.detectPii = emailDetector();
    const { ctx, events } = mkCtx({ orgShield: OWN_SERVER_EMAIL });
    const out = await executeDirectChatToolCall(mkToolCall('notebook_read', { note: `mail ${SYNTH_EMAIL}` }), ctx);

    assert.strictEqual(dispatcher.calls.length, 0, 'a refused tool must not be dispatched');
    assert.match(JSON.parse(out.content).error, /was not called: its arguments contained Email Address/);
    assert.deepStrictEqual(events[1], ['tool_end', { name: 'notebook_read', result: '[Tool blocked — arguments contain sensitive information (Email Address)]' }]);
    assert.strictEqual(guardrails.rows.length, 1);
    assert.strictEqual(guardrails.rows[0].action_taken, 'tool_blocked');
    assert.strictEqual(guardrails.rows[0].source, 'direct');
});

test('BFSF-354 a blocked category in an own-server result is stripped before the model reads it', async () => {
    toolPiiGate._deps.detectPii = emailDetector();
    dispatcher.impl = async () => ({ passage: `reach ${SYNTH_EMAIL}` });
    for (const streamed of [false, true]) {
        guardrails.rows = [];
        const { ctx, events } = mkCtx({ orgShield: OWN_SERVER_EMAIL, streamed });
        const out = await executeDirectChatToolCall(mkToolCall('kb_search', { query: 'contact' }), ctx);
        assert.ok(!out.content.includes(SYNTH_EMAIL), `streamed=${streamed}: the model still reads the blocked value`);
        assert.match(out.content, /\[blocked:email\]/);
        // The UI's tool_end carries the raw result, as in the agent loop.
        assert.deepStrictEqual(events[events.length - 1], ['tool_end', { name: 'kb_search', result: { passage: `reach ${SYNTH_EMAIL}` } }]);
        assert.ok(guardrails.rows.some(r => r.action_taken === 'tool_result_redacted'));
    }
});

test('BFSF-354 an outside tool is not held to the own-server list', async () => {
    toolPiiGate._deps.detectPii = emailDetector();
    dispatcher.impl = async () => ({ sent: SYNTH_EMAIL });
    const { ctx } = mkCtx({ orgShield: OWN_SERVER_EMAIL });
    const out = await executeDirectChatToolCall(mkToolCall('gmail_send', { to: SYNTH_EMAIL }), ctx);
    assert.strictEqual(dispatcher.calls.length, 1);
    assert.ok(out.content.includes(SYNTH_EMAIL));
});

test('BFSF-354 a fail-closed org refuses the tool when the scan cannot run', async () => {
    toolPiiGate._deps.detectPii = async () => ({ hasPii: false, entities: [], degraded: true, degradedReason: 'guard_unreachable: test' });
    const { ctx } = mkCtx({ orgShield: { ...OWN_SERVER_EMAIL, privacyAction: 'block' } });
    const out = await executeDirectChatToolCall(mkToolCall('notebook_read', { note: 'x' }), ctx);
    assert.strictEqual(dispatcher.calls.length, 0);
    assert.match(JSON.parse(out.content).error, /PII guard is unavailable/);
});
