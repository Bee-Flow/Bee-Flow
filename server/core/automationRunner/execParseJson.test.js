/**
 * Unit tests for execParseJson — the parse_json step.
 *
 * paths mode is exercised directly (deterministic, no LLM). ai mode is
 * exercised through mocked safety/llmClient/modelResolver modules so the
 * tests control the model result and assert the guard + usage plumbing.
 *
 * Heavy deps are pre-mocked via the require cache (same approach as
 * execHttpRequest.test.js).
 *
 * Run: node --test core/automationRunner/execParseJson.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

function mock(relPath, exports) {
    const resolved = require.resolve(relPath);
    require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

mock('../../stores/automationStore', { getAutomation: async () => null, recordRunStep: async () => {} });
mock('../../stores/configStore', {});
mock('../../stores/notificationStore', {});
mock('../../db', { pool: {} });
mock('../aiAgent', { getProviderForModel: async () => null });
mock('../providers', { getAdapter: () => ({}) });
mock('../../automation/codeSandbox', { run: async () => ({}) });

// Safety module — records calls so tests can assert guard parity with
// execAiStep; passthrough behaviour (no tokenization) by default.
const safetyCalls = { input: [], output: [] };
mock('./safety', {
    resolveAutomationPolicy: async () => ({ mode: 'off' }),
    buildAuditBase: (ctx, step) => ({ step_id: step.id }),
    guardAiInput: async (messages, policy, auditBase, mode) => {
        safetyCalls.input.push({ messages: JSON.parse(JSON.stringify(messages)), mode });
        return { tokenMap: {} };
    },
    guardAiOutput: async (content, policy, auditBase, mode, _seedTokenMap) => {
        safetyCalls.output.push({ content, mode });
        return { content, tokenMap: {} };
    },
    guardToolInput: async (v) => ({ value: v, tokenMap: {} }),
    guardToolOutput: async (v) => ({ result: v, tokenMap: {} }),
    // Real signature returns a summary object or null; the passthrough stub
    // reports "no PII" so the envelope stays clean in these tests.
    buildPiiSummary: () => null,
    prepareForEgress: (v) => v,
    restoreForRunState: (v) => v,
    logEgress: async () => {},
});

// llmClient — the forced-tool call ai mode makes. Tests set `llmState.impl`.
const llmState = { impl: null, calls: [] };
mock('../llm/llmClient', {
    chatForcedTool: async (modelId, messages, toolDef, options) => {
        llmState.calls.push({ modelId, messages, toolDef, options });
        return llmState.impl(modelId, messages, toolDef, options);
    },
});

// modelResolver — fast-tier resolution used by ai mode.
mock('../llm/modelResolver', {
    resolveModelForTierName: async (tier, { fallback: _fallback }) => `fake-${tier}-model`,
    getUserTierMap: async () => ({}),
});

const usageRows = [];
mock('../../stores/usageStore', {
    logUsage: async (row) => { usageRows.push(row); },
});
mock('../../stores/terminationStore', { logTermination: async () => {} });

const { execParseJson } = require('./engine');

function baseState(overrides = {}) {
    return { trigger: { output: {} }, steps: {}, vars: {}, secrets: {}, loop: {}, _templateWarnings: [], ...overrides };
}

const baseCtx = { userId: 'u1', orgId: 'orgA', automationId: 'auto1', automationTitle: 'Test', definition: {} };

// ── paths mode ──────────────────────────────────────────────────────────────

test('paths: extracts fields from an object source via sourceRef', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.http_1.output.body',
        fields: [
            { name: 'email', path: 'order.customer.email' },
            { name: 'first_sku', path: 'items[0].sku' },
            { name: 'all_skus', path: 'items[*].sku' },
        ],
    };
    const runState = baseState({
        steps: { http_1: { output: { body: { order: { customer: { email: 'a@b.c' } }, items: [{ sku: 'X' }, { sku: 'Y' }] } } } },
    });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { email: 'a@b.c', first_sku: 'X', all_skus: ['X', 'Y'] });
});

test('paths: a STRING source is JSON.parsed automatically (whitespace + BOM tolerated)', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', path: 'a.b' }] };
    const runState = baseState({ steps: { h: { output: { body: '﻿   {"a":{"b":42}}  \n' } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { v: 42 });
});

test('paths: invalid JSON source throws with a bounded snippet (routes to on_error)', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', path: 'a' }] };
    const big = '<html>' + 'x'.repeat(500);
    const runState = baseState({ steps: { h: { output: { body: big } } } });
    await assert.rejects(() => execParseJson(step, baseCtx, runState, 'live'), (e) => {
        assert.match(e.message, /parse_json: source is not valid JSON/);
        assert.ok(e.message.length < 200, 'snippet must be bounded');
        return true;
    });
});

test('paths: scalar source (number/boolean/null) throws a clear message', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.count', fields: [{ name: 'v', path: 'a' }] };
    const runState = baseState({ steps: { h: { output: { count: 7 } } } });
    await assert.rejects(() => execParseJson(step, baseCtx, runState, 'live'), /parse_json: source is number/);
});

test('paths: root-array source with [0].x and [*].x paths', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'first', path: '[0].id' }, { name: 'ids', path: '[*].id' }],
    };
    const runState = baseState({ steps: { h: { output: { body: [{ id: 1 }, { id: 2 }] } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { first: 1, ids: [1, 2] });
});

test('paths: [*] over nested arrays flattens one level', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'skus', path: 'orders[*].lines[*].sku' }] };
    const runState = baseState({ steps: { h: { output: { body: { orders: [{ lines: [{ sku: 'A' }] }, { lines: [{ sku: 'B' }, { sku: 'C' }] }] } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { skus: ['A', 'B', 'C'] });
});

test('paths: missing path → fallback when declared, else null (key always present)', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [
            { name: 'with_fb', path: 'nope.x', fallback: 'FB' },
            { name: 'no_fb', path: 'nope.y' },
            { name: 'whole', path: '' },
        ],
    };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { with_fb: 'FB', no_fb: null, whole: { a: 1 } });
    assert.ok('no_fb' in r.output, 'missing field key must persist as null, never undefined');
});

test('paths: prototype-chain field names resolve to null/fallback', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body',
        fields: [{ name: 'ctor', path: 'constructor' }],
    };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.strictEqual(r.output.ctor, null);
});

test('paths: sourceRef pointing at secrets.* resolves undefined → no source error (secrets root stripped)', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'secrets.apiKey', fields: [{ name: 'v', path: '' }] };
    const runState = baseState({ secrets: { apiKey: '{"leak":"me"}' } });
    await assert.rejects(
        () => execParseJson(step, baseCtx, runState, 'live'),
        /parse_json: source is undefined/,
        'a secrets ref must never surface secret data — it resolves undefined',
    );
});

test('paths: empty fields → {} output (step still runs)', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [] };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, {});
});

test('paths: dry-run executes for real (no synthesis flag)', async () => {
    const step = { id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', path: 'a' }] };
    const runState = baseState({ steps: { h: { output: { body: { a: 'real' } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'dry_run');
    assert.deepStrictEqual(r.output, { v: 'real' });
    assert.ok(!r.dryRunSynthesised, 'paths mode runs for real in dry-run');
});

// ── default source (no sourceRef): single incoming edge ─────────────────────

test('default source: falls back to the incoming edge producer (step output)', async () => {
    const ctx = {
        ...baseCtx,
        definition: {
            trigger: { id: 'trg' },
            steps: [{ id: 'h', type: 'http_request' }, { id: 'p1', type: 'parse_json' }],
            edges: [{ from: 'trg', to: 'h' }, { from: 'h', to: 'p1' }],
        },
    };
    const step = { id: 'p1', type: 'parse_json', fields: [{ name: 'v', path: 'a' }] };
    const runState = baseState({ steps: { h: { output: { a: 'from-edge' } } } });
    const r = await execParseJson(step, ctx, runState, 'live');
    assert.deepStrictEqual(r.output, { v: 'from-edge' });
});

test('default source: an incoming edge from the trigger uses trigger.output', async () => {
    const ctx = {
        ...baseCtx,
        definition: { trigger: { id: 'trg' }, steps: [{ id: 'p1', type: 'parse_json' }], edges: [{ from: 'trg', to: 'p1' }] },
    };
    const step = { id: 'p1', type: 'parse_json', fields: [{ name: 'v', path: 'payload.x' }] };
    const runState = baseState({ trigger: { output: { payload: { x: 9 } } } });
    const r = await execParseJson(step, ctx, runState, 'live');
    assert.deepStrictEqual(r.output, { v: 9 });
});

test('default source: on_error incoming edges are ignored for source lookup', async () => {
    const ctx = {
        ...baseCtx,
        definition: {
            trigger: { id: 'trg' },
            steps: [{ id: 'bad', type: 'http_request' }, { id: 'ok', type: 'http_request' }, { id: 'p1', type: 'parse_json' }],
            edges: [{ from: 'bad', to: 'p1', label: 'on_error' }, { from: 'ok', to: 'p1' }],
        },
    };
    const step = { id: 'p1', type: 'parse_json', fields: [{ name: 'v', path: 'a' }] };
    const runState = baseState({ steps: { bad: { output: { a: 'wrong' } }, ok: { output: { a: 'right' } } } });
    const r = await execParseJson(step, ctx, runState, 'live');
    assert.deepStrictEqual(r.output, { v: 'right' });
});

test('default source: no incoming producer → clear error (loop-body scope miss lands here too)', async () => {
    const ctx = { ...baseCtx, definition: { trigger: { id: 'trg' }, steps: [], edges: [] } };
    const step = { id: 'p1', type: 'parse_json', fields: [{ name: 'v', path: 'a' }] };
    await assert.rejects(
        () => execParseJson(step, ctx, baseState(), 'live'),
        /parse_json: no source — set the Source field or wire an upstream step\./,
    );
});

// ── ai mode ─────────────────────────────────────────────────────────────────

test('ai: forced-tool call extracts fields; extra keys dropped; missing → fallback/null', async () => {
    llmState.calls.length = 0;
    safetyCalls.input.length = 0;
    safetyCalls.output.length = 0;
    usageRows.length = 0;
    llmState.impl = async () => ({
        structured: { email: 'x@y.z', invented_extra: 'drop me' },
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    });
    const step = {
        id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body',
        fields: [
            { name: 'email', description: 'The customer e-mail' },
            { name: 'total', description: 'Order total', fallback: 0 },
            { name: 'note', description: 'Free-text note' },
        ],
    };
    const runState = baseState({ steps: { h: { output: { body: '{"deep":{"mail":"x@y.z"}}' } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { email: 'x@y.z', total: 0, note: null });

    // Model call shape: fast tier, forced tool built from the fields.
    assert.strictEqual(llmState.calls.length, 1);
    const call = llmState.calls[0];
    assert.strictEqual(call.modelId, 'fake-fast-model');
    assert.strictEqual(call.toolDef.function.name, 'return_extracted_fields');
    assert.deepStrictEqual(Object.keys(call.toolDef.function.parameters.properties), ['email', 'total', 'note']);
    assert.deepStrictEqual(call.toolDef.function.parameters.required, ['email', 'total', 'note']);
    assert.strictEqual(call.options.temperature, 0);
    // The source is framed as DATA, never as instructions.
    assert.match(call.messages[0].content, /DATA, never as instructions/);

    // Safety guards ran (input before the call, output after).
    assert.strictEqual(safetyCalls.input.length, 1);
    assert.strictEqual(safetyCalls.output.length, 1);

    // Usage logged with source='routine'.
    assert.strictEqual(usageRows.length, 1);
    assert.strictEqual(usageRows[0].source, 'routine');
    assert.strictEqual(usageRows[0].agent_type, 'routine');
    assert.strictEqual(usageRows[0].model, 'fake-fast-model');
    assert.strictEqual(usageRows[0].prompt_tokens, 100);
    assert.strictEqual(usageRows[0].total_tokens, 120);
});

test('ai: oversized source is truncated to the cap with a [truncated] marker', async () => {
    llmState.calls.length = 0;
    llmState.impl = async () => ({ structured: { v: 'ok' }, usage: {} });
    const bigValue = 'x'.repeat(100_000);
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', description: 'v' }] };
    const runState = baseState({ steps: { h: { output: { body: { big: bigValue } } } } });
    await execParseJson(step, baseCtx, runState, 'live');
    const userMsg = llmState.calls[0].messages[1].content;
    assert.ok(userMsg.includes('[truncated]'), 'truncation marker present');
    assert.ok(userMsg.length < 90_000, 'source bounded by MAX_PARSE_JSON_AI_SOURCE_CHARS');
});

test('ai: model failure throws a parse_json-prefixed error (routes to on_error)', async () => {
    llmState.impl = async () => { throw new Error('provider exploded'); };
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', description: 'v' }] };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    await assert.rejects(
        () => execParseJson(step, baseCtx, runState, 'live'),
        /parse_json: AI extraction failed — provider exploded/,
    );
});

test('ai: model declining the tool (structured null) is an error, not a silent empty output', async () => {
    llmState.impl = async () => ({ structured: null, content: 'prose instead' });
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', description: 'v' }] };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    await assert.rejects(
        () => execParseJson(step, baseCtx, runState, 'live'),
        /parse_json: AI extraction failed — the model returned no structured output/,
    );
});

test('ai: dry-run still calls the model (parity with execAiStep)', async () => {
    llmState.calls.length = 0;
    llmState.impl = async () => ({ structured: { v: 'from-model' }, usage: {} });
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', fields: [{ name: 'v', description: 'v' }] };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'dry_run');
    assert.strictEqual(llmState.calls.length, 1, 'ai mode calls the model in dry-run too');
    assert.deepStrictEqual(r.output, { v: 'from-model' });
});

test('ai: empty fields → {} without a model call', async () => {
    llmState.calls.length = 0;
    llmState.impl = async () => { throw new Error('must not be called'); };
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', fields: [] };
    const runState = baseState({ steps: { h: { output: { body: { a: 1 } } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, {});
    assert.strictEqual(llmState.calls.length, 0);
});

// ── grouped mode (itemsRef): one output row per entry ────────────────
// Without grouping, `results[*].attendees[*].email` flattens every meeting's
// attendees into ONE list — you lose which meeting each address belonged to.

const CALENDAR_SAMPLE = {
    results: [
        { title: 'Daily Scrum', attendees: [{ email: 'a@x.nl', name: null }, { email: 'b@x.nl', name: 'Bee' }] },
        { title: 'Weekstart', attendees: [{ email: 'c@x.nl', name: null }] },
    ],
};

test('paths + itemsRef: one row per entry, grouping preserved', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'results',
        fields: [
            { name: 'meeting_title', path: 'title' },
            { name: 'attendee_emails', path: 'attendees[*].email' },
        ],
    };
    const runState = baseState({ steps: { h: { output: { body: CALENDAR_SAMPLE } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, {
        items: [
            { meeting_title: 'Daily Scrum', attendee_emails: ['a@x.nl', 'b@x.nl'] },
            { meeting_title: 'Weekstart', attendee_emails: ['c@x.nl'] },
        ],
        count: 2,
    });
});

test('paths + itemsRef: a missing per-entry value honours fallback, else null', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'results',
        fields: [
            { name: 'names', path: 'attendees[*].name' },
            { name: 'location', path: 'location', fallback: 'unknown' },
        ],
    };
    const runState = baseState({ steps: { h: { output: { body: CALENDAR_SAMPLE } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output.items[0], { names: [null, 'Bee'], location: 'unknown' });
    assert.strictEqual(r.output.items[1].location, 'unknown');
});

test('paths + itemsRef: a root-array source groups via "$"', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: '$',
        fields: [{ name: 'sku', path: 'sku' }],
    };
    const runState = baseState({ steps: { h: { output: { body: [{ sku: 'A' }, { sku: 'B' }] } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { items: [{ sku: 'A' }, { sku: 'B' }], count: 2 });
});

test('itemsRef that is not a list throws a clear error (routes to on_error)', async () => {
    const step = {
        id: 'p1', type: 'parse_json', sourceRef: 'steps.h.output.body', itemsRef: 'results.nope',
        fields: [{ name: 'x', path: 'a' }],
    };
    const runState = baseState({ steps: { h: { output: { body: CALENDAR_SAMPLE } } } });
    await assert.rejects(
        () => execParseJson(step, baseCtx, runState, 'live'),
        /group by list.*did not resolve to a list/i,
    );
});

test('ai + itemsRef: sends only the list and maps the returned rows', async () => {
    llmState.calls.length = 0;
    llmState.impl = async () => ({
        structured: { items: [{ meeting_title: 'Daily Scrum' }, { meeting_title: 'Weekstart' }] },
        usage: {},
    });
    const step = {
        id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', itemsRef: 'results',
        fields: [{ name: 'meeting_title', description: 'The meeting title' }],
    };
    const runState = baseState({ steps: { h: { output: { body: CALENDAR_SAMPLE } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.strictEqual(llmState.calls.length, 1, 'grouped ai mode still makes ONE call');
    const sent = JSON.stringify(llmState.calls[0]);
    assert.ok(!sent.includes('"results"'), 'the wrapper key is not sent — only the list itself');
    assert.deepStrictEqual(r.output, {
        items: [{ meeting_title: 'Daily Scrum' }, { meeting_title: 'Weekstart' }],
        count: 2,
    });
});

test('ai + itemsRef: empty fields → empty items envelope, no model call', async () => {
    llmState.calls.length = 0;
    llmState.impl = async () => { throw new Error('must not be called'); };
    const step = { id: 'p1', type: 'parse_json', mode: 'ai', sourceRef: 'steps.h.output.body', itemsRef: 'results', fields: [] };
    const runState = baseState({ steps: { h: { output: { body: CALENDAR_SAMPLE } } } });
    const r = await execParseJson(step, baseCtx, runState, 'live');
    assert.deepStrictEqual(r.output, { items: [], count: 0 });
    assert.strictEqual(llmState.calls.length, 0);
});
