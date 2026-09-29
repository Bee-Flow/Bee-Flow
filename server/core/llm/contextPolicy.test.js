/**
 * Unit tests — the org context policy and the compaction gate it drives.
 *
 * Run: node --test core/llm/contextPolicy.test.js
 *
 * The behaviour being pinned down: local compaction is a LOSSY rewrite of the
 * user's conversation (a fast-tier summary replaces older turns, tool results
 * get truncated). It used to run unconditionally from the 16th message, which
 * is what users experienced as "the assistant forgot what we discussed". It is
 * now opt-in per organisation and OFF by default, with an emergency fold that
 * still keeps a conversation inside the model's context window.
 *
 * configStore is stubbed via require.cache so no DB is touched.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stub configStore before requiring the module under test ─────────────
const configStorePath = require.resolve('../../stores/configStore');
const configStub = {
    rows: new Map(),
    reads: [],
    throwNext: false,
    getConfig: async (key) => {
        configStub.reads.push(key);
        if (configStub.throwNext) throw new Error('config store down');
        return configStub.rows.has(key) ? configStub.rows.get(key) : null;
    },
    setConfig: async (key, value) => { configStub.rows.set(key, value); },
};
require.cache[configStorePath] = {
    id: configStorePath, filename: configStorePath, loaded: true, exports: configStub,
};

// llmClient is stubbed too — the overflow-guard test folds for real.
const llmClientPath = require.resolve('./llmClient');
require.cache[llmClientPath] = {
    id: llmClientPath, filename: llmClientPath, loaded: true,
    exports: { chat: async () => ({ content: 'EMERGENCY-SUMMARY' }) },
};

const {
    resolveContextPolicy, invalidateContextPolicy, normalizePolicy,
    buildCompactionOptions, contextWindowFor, overflowTokensFor,
    contextWindowExamples,
    CONFIG_KEY_PREFIX, DEFAULT_CONTEXT_BUDGET_PERCENT,
} = require('./contextPolicy');
const { compactMessages, needsSummarization } = require('./compaction');

beforeEach(() => {
    configStub.rows.clear();
    configStub.reads = [];
    configStub.throwNext = false;
    delete process.env.BEEFLOW_CHAT_COMPACTION_DEFAULT;
    invalidateContextPolicy('org-1');
    invalidateContextPolicy(null);
});

// ── normalizePolicy ─────────────────────────────────────────────────────

test('the product default is compaction OFF', () => {
    assert.strictEqual(normalizePolicy(null).compactionEnabled, false);
    assert.strictEqual(normalizePolicy({}).compactionEnabled, false);
    assert.strictEqual(normalizePolicy({ compactionEnabled: true }).compactionEnabled, true);
});

test('BEEFLOW_CHAT_COMPACTION_DEFAULT flips the default for unconfigured orgs only', () => {
    process.env.BEEFLOW_CHAT_COMPACTION_DEFAULT = '1';
    assert.strictEqual(normalizePolicy(null).compactionEnabled, true, 'unconfigured follows the env default');
    assert.strictEqual(normalizePolicy({ compactionEnabled: false }).compactionEnabled, false,
        'an explicit org choice always wins over the env default');
});

test('out-of-range tunables are clamped, never propagated', () => {
    const p = normalizePolicy({ compactionEnabled: true, compactionThreshold: 1, recentWindow: 9999 });
    assert.ok(p.compactionThreshold >= 4);
    // The recent window has to stay below the threshold or the fold boundary
    // lands at/behind the watermark and nothing is ever actually folded.
    assert.ok(p.recentWindow < p.compactionThreshold, `${p.recentWindow} < ${p.compactionThreshold}`);

    const garbage = normalizePolicy({ compactionThreshold: 'sixteen', recentWindow: null });
    assert.strictEqual(garbage.compactionThreshold, 16);
    assert.strictEqual(garbage.recentWindow, 8);
});

// ── resolveContextPolicy ────────────────────────────────────────────────

test('a stored org row is honoured, and memoised', async () => {
    configStub.rows.set(`${CONFIG_KEY_PREFIX}org-1`, { compactionEnabled: true });

    assert.strictEqual((await resolveContextPolicy('org-1')).compactionEnabled, true);
    const readsAfterFirst = configStub.reads.length;
    assert.strictEqual((await resolveContextPolicy('org-1')).compactionEnabled, true);
    assert.strictEqual(configStub.reads.length, readsAfterFirst, 'second call served from the memo');

    // A save has to be visible on the very next message, not 30s later.
    configStub.rows.set(`${CONFIG_KEY_PREFIX}org-1`, { compactionEnabled: false });
    invalidateContextPolicy('org-1');
    assert.strictEqual((await resolveContextPolicy('org-1')).compactionEnabled, false);
});

test('no org id (personal account) never touches the config store', async () => {
    const policy = await resolveContextPolicy(null);
    assert.strictEqual(policy.compactionEnabled, false);
    assert.deepStrictEqual(configStub.reads, []);
});

test('a config-store failure falls back to the conservative default', async () => {
    configStub.throwNext = true;
    const policy = await resolveContextPolicy('org-1');
    assert.strictEqual(policy.compactionEnabled, false,
        'failing open into a lossy rewrite of the conversation would be the wrong direction');
});

// ── context window sizing ───────────────────────────────────────────────

test('context windows: 1M on the current Claude families, 200k on Haiku/older', () => {
    assert.strictEqual(contextWindowFor('claude-opus-5'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-sonnet-5'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-opus-4-6'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-sonnet-4-6'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-fable-5'), 1_000_000);
    assert.strictEqual(contextWindowFor('claude-haiku-4-5'), 200_000);
    assert.strictEqual(contextWindowFor('claude-sonnet-4-5-20250929'), 200_000);
    assert.strictEqual(contextWindowFor('claude-3-5-sonnet-20241022'), 200_000);
    // Unknown ids get a conservative floor rather than an optimistic guess.
    assert.strictEqual(contextWindowFor('some-unknown-model'), 128_000);
    assert.strictEqual(overflowTokensFor('claude-opus-5'), 1_000_000 * DEFAULT_CONTEXT_BUDGET_PERCENT / 100);
});

test('context windows: 256k on the current Mistral line-up, 128k on its older generations', () => {
    assert.strictEqual(contextWindowFor('mistral-large-latest'), 256_000);
    assert.strictEqual(contextWindowFor('mistral-medium-latest'), 256_000);
    assert.strictEqual(contextWindowFor('mistral-small-2603'), 256_000);
    assert.strictEqual(contextWindowFor('ministral-8b-latest'), 256_000);
    assert.strictEqual(contextWindowFor('codestral-latest'), 128_000);
    assert.strictEqual(contextWindowFor('mistral-large-2411'), 128_000);
    assert.strictEqual(contextWindowFor('magistral-medium-latest'), 128_000);
});

test('the context budget is a percentage of the model window, not a token count', () => {
    // The point of expressing it as a percentage: one setting, correct on every
    // model, and still correct after the org switches model.
    assert.strictEqual(overflowTokensFor('claude-sonnet-5', 50), 500_000);
    assert.strictEqual(overflowTokensFor('claude-haiku-4-5', 50), 100_000);
    assert.strictEqual(overflowTokensFor('claude-sonnet-5', 95), 950_000);

    // A garbage percent falls back to the default rather than producing 0 —
    // a zero budget would fold every conversation on its third message.
    assert.strictEqual(overflowTokensFor('claude-sonnet-5', undefined), 750_000);
    assert.strictEqual(overflowTokensFor('claude-sonnet-5', NaN), 750_000);
});

test('the percentage is clamped into a range that can never fold everything', () => {
    assert.strictEqual(normalizePolicy({ contextBudgetPercent: 50 }).contextBudgetPercent, 50);
    assert.strictEqual(normalizePolicy({ contextBudgetPercent: 0 }).contextBudgetPercent, 25);
    assert.strictEqual(normalizePolicy({ contextBudgetPercent: 400 }).contextBudgetPercent, 95);
    assert.strictEqual(normalizePolicy({ contextBudgetPercent: 'lots' }).contextBudgetPercent, 75);
    assert.strictEqual(normalizePolicy(null).contextBudgetPercent, DEFAULT_CONTEXT_BUDGET_PERCENT);
});

test('the settings screen gets real context windows, not a second hardcoded table', () => {
    const examples = contextWindowExamples();
    assert.ok(examples.length >= 2);
    for (const ex of examples) {
        assert.ok(typeof ex.label === 'string' && ex.label);
        assert.strictEqual(ex.contextWindow, contextWindowFor(ex.label.toLowerCase().replace(/[ .]/g, '-')),
            `${ex.label} must be derived from contextWindowFor, not typed out again`);
    }
});

// ── the gate itself ─────────────────────────────────────────────────────

function mkConv(n) {
    return Array.from({ length: n }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `msg${i}x`,
    }));
}

test('disabled: a long conversation passes through completely untouched', async () => {
    const opts = buildCompactionOptions({
        policy: normalizePolicy(null), modelId: 'claude-opus-5',
    });
    const messages = mkConv(40);

    assert.strictEqual(needsSummarization(messages, opts), false);
    const out = await compactMessages(messages, opts);
    assert.strictEqual(out.didSummarize, false);
    assert.strictEqual(out.messages.length, messages.length);
    assert.deepStrictEqual(out.messages, messages);
});

test('REGRESSION: with compaction off, tool results are NOT truncated', async () => {
    const bigResult = 'R'.repeat(5000);
    const messages = [
        { role: 'user', content: 'read the file' },
        { role: 'assistant', content: null, tool_calls: [{ id: 't1', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 't1', content: bigResult },
        { role: 'assistant', content: 'done' },
    ];

    const off = buildCompactionOptions({ policy: normalizePolicy(null), modelId: 'claude-opus-5' });
    const kept = await compactMessages(messages, off);
    assert.strictEqual(kept.messages[2].content, bigResult,
        'truncating every tool result on every turn was the largest silent context loss in the product');

    // …and the opposite when the org opted in.
    const on = buildCompactionOptions({ policy: normalizePolicy({ compactionEnabled: true }), modelId: 'claude-opus-5' });
    const pruned = await compactMessages(messages, on);
    assert.ok(pruned.messages[2].content.length < bigResult.length, 'opted in → pruning is expected');
    assert.ok(pruned.messages[2].content.includes('[truncated]'));
});

test('disabled: the overflow guard still folds a conversation near the context window', async () => {
    // ~4 chars/token, so 12 messages x 400k chars ≈ 1.2M tokens — comfortably
    // past the guard for a 200k-token model.
    const messages = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(400_000),
    }));
    const opts = buildCompactionOptions({
        policy: normalizePolicy(null), modelId: 'claude-haiku-4-5',
    });

    assert.strictEqual(needsSummarization(messages, opts), true, 'guard must fire before the API 400s');
    const out = await compactMessages(messages, opts);
    assert.strictEqual(out.didSummarize, true);

    // The fold is measured in TOKENS, not message count: the summary block and
    // the pinned original goal add rows back, so a shrinking array is the wrong
    // thing to assert on.
    const size = (msgs) => msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    assert.ok(size(out.messages) < size(messages) / 2,
        `expected a large reduction, got ${size(out.messages)} from ${size(messages)}`);
});

test('disabled: a short conversation is never folded, however big the guard says it is', async () => {
    const messages = [
        { role: 'user', content: 'x'.repeat(4_000_000) },
        { role: 'assistant', content: 'ok' },
    ];
    const opts = buildCompactionOptions({
        policy: normalizePolicy(null), modelId: 'claude-haiku-4-5',
    });
    // Two turns cannot be summarised into anything better than the two turns.
    assert.strictEqual(needsSummarization(messages, opts), false);
});

test('the overflow guard is a safety net, so it fires with compaction ENABLED too', async () => {
    // Ten enormous turns never reach the 16-message threshold, but they do blow
    // a 200k window. Before the fold-reason refactor the guard was only
    // consulted on the compaction-disabled branch, so this 400'd upstream.
    const messages = Array.from({ length: 10 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(400_000),
    }));
    const opts = buildCompactionOptions({
        policy: normalizePolicy({ compactionEnabled: true }), modelId: 'claude-haiku-4-5',
    });

    assert.ok(messages.length < opts.threshold, 'precondition: below the message-count trigger');
    assert.strictEqual(needsSummarization(messages, opts), true);

    const size = (msgs) => msgs.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
    const out = await compactMessages(messages, opts);
    assert.strictEqual(out.didSummarize, true);
    assert.ok(size(out.messages) < size(messages) / 2,
        'an overflow fold must use the token boundary, not the fixed recent window');
});

test('a lower percentage makes the guard fire sooner', async () => {
    const messages = Array.from({ length: 12 }, (_, i) => ({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: 'x'.repeat(30_000), // ~7.5k tokens each, ~90k total
    }));
    const at75 = buildCompactionOptions({ policy: normalizePolicy(null), modelId: 'claude-haiku-4-5' });
    const at25 = buildCompactionOptions({
        policy: normalizePolicy({ contextBudgetPercent: 25 }), modelId: 'claude-haiku-4-5',
    });

    assert.strictEqual(needsSummarization(messages, at75), false, '90k is well under 150k');
    assert.strictEqual(needsSummarization(messages, at25), true, '90k is over 50k');
});

test('enabled: the historical message-count trigger is restored verbatim', async () => {
    const opts = buildCompactionOptions({
        policy: normalizePolicy({ compactionEnabled: true }), modelId: 'claude-opus-5',
    });
    assert.strictEqual(needsSummarization(mkConv(16), opts), false, 'threshold is exclusive');
    assert.strictEqual(needsSummarization(mkConv(17), opts), true);
});

test('buildCompactionOptions carries the watermark through — the fold must be incremental', () => {
    const opts = buildCompactionOptions({
        policy: normalizePolicy({ compactionEnabled: true }),
        existingSummary: 'earlier stuff',
        summaryUpTo: 12,
        modelId: 'claude-opus-5',
        userOrgId: 'org-1',
    });
    assert.strictEqual(opts.summaryUpTo, 12);
    assert.strictEqual(opts.existingSummary, 'earlier stuff');
    assert.strictEqual(opts.userOrgId, 'org-1');
    assert.strictEqual(opts.summaryModelId, 'tier:fast');
    // A missing watermark must normalise to 0, never NaN/undefined — the
    // agent runtime shipped without one, so every turn re-folded the whole
    // prefix and rewrote the summary (and with it the cached prompt prefix).
    assert.strictEqual(buildCompactionOptions({ policy: normalizePolicy(null) }).summaryUpTo, 0);
});
