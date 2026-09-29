/**
 * Unit tests for conversation compaction — the watermark logic in particular.
 *
 * Run: node --test core/compaction.test.js
 *
 * The regression under test: once a conversation crossed COMPACTION_THRESHOLD,
 * compaction used to re-run a real summarization LLM call on EVERY turn
 * (history is rebuilt from the full DB record each turn and only the summary
 * text was persisted, never a watermark). With `summaryUpTo` the fold happens
 * once and later turns take a zero-LLM-call skip path until the unsummarized
 * tail crosses the threshold again.
 *
 * llmClient is stubbed via require.cache so no network/DB is touched. The
 * summaryModelId is a non-`tier:` id so modelResolver is never required.
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');

// ── Stub llmClient before requiring the module under test ────────────────
const llmClientPath = require.resolve('./llmClient');
const llmStub = {
    calls: [],
    nextSummary: 'FRESH-SUMMARY',
    failNext: false,
    chat: async (modelId, messages, opts) => {
        llmStub.calls.push({ modelId, messages, opts });
        if (llmStub.failNext) throw new Error('summarizer down');
        return { content: llmStub.nextSummary };
    },
};
require.cache[llmClientPath] = { id: llmClientPath, filename: llmClientPath, loaded: true, exports: llmStub };

const { compactMessages, needsSummarization, COMPACTION_THRESHOLD, RECENT_WINDOW } = require('./compaction');

beforeEach(() => {
    llmStub.calls = [];
    llmStub.nextSummary = 'FRESH-SUMMARY';
    llmStub.failNext = false;
});

// Alternating user/assistant conversation; content `msg<i>x` is uniquely
// greppable (trailing x prevents msg1 matching msg10).
function mkConv(n, startAt = 0) {
    return Array.from({ length: n }, (_, i) => ({
        role: (startAt + i) % 2 === 0 ? 'user' : 'assistant',
        content: `msg${startAt + i}x`,
    }));
}

const OPTS = { summaryModelId: 'test-model' };

function summaryMessageOf(result) {
    return result.messages.find(m => {
        if (m.role !== 'user') return false;
        const text = typeof m.content === 'string'
            ? m.content
            : (Array.isArray(m.content) ? m.content.map(b => b.text || '').join(' ') : '');
        return text.includes('[Conversation Summary');
    });
}

test('below threshold without prior summary: passthrough, no LLM call', async () => {
    const conv = mkConv(10);
    const result = await compactMessages(conv, { ...OPTS });

    assert.strictEqual(llmStub.calls.length, 0);
    assert.strictEqual(result.didSummarize, false);
    assert.strictEqual(result.summaryUpTo, 0);
    assert.strictEqual(result.newSummary, null);
    assert.strictEqual(result.messages.length, 10);
    assert.strictEqual(needsSummarization(conv, OPTS), false);
});

test('first crossing: one fold, watermark recorded', async () => {
    const conv = mkConv(COMPACTION_THRESHOLD + 1); // 17
    assert.strictEqual(needsSummarization(conv, OPTS), true);

    const result = await compactMessages(conv, { ...OPTS });

    assert.strictEqual(llmStub.calls.length, 1);
    assert.strictEqual(result.didSummarize, true);
    assert.strictEqual(result.newSummary, 'FRESH-SUMMARY');
    assert.strictEqual(result.summaryUpTo, 17 - RECENT_WINDOW); // 9

    // Recent window kept verbatim, folded prefix gone
    const flat = JSON.stringify(result.messages);
    assert.ok(flat.includes('msg9x') && flat.includes('msg16x'));
    assert.ok(!flat.includes('msg8x') || flat.includes('[Original request'), 'folded prefix should be gone');
    const summaryMsg = summaryMessageOf(result);
    assert.ok(summaryMsg, 'summary message present');
    assert.ok(JSON.stringify(summaryMsg.content).includes('FRESH-SUMMARY'));
});

test('REGRESSION: turn after a fold takes the skip path — zero LLM calls', async () => {
    // Two turns after the first fold: 17 + 2 = 19 conv messages, watermark 9
    const conv = mkConv(19);
    const opts = { ...OPTS, existingSummary: 'STORED-SUMMARY', summaryUpTo: 9 };

    assert.strictEqual(needsSummarization(conv, opts), false); // tail 10 ≤ 16

    const result = await compactMessages(conv, opts);

    assert.strictEqual(llmStub.calls.length, 0, 'skip path must not call the summarizer');
    assert.strictEqual(result.didSummarize, false);
    assert.strictEqual(result.newSummary, 'STORED-SUMMARY');
    assert.strictEqual(result.summaryUpTo, 9, 'watermark unchanged');

    // Stored summary replayed + 10-message tail verbatim
    const summaryMsg = summaryMessageOf(result);
    assert.ok(JSON.stringify(summaryMsg.content).includes('STORED-SUMMARY'));
    const flat = JSON.stringify(result.messages);
    for (let i = 9; i < 19; i++) assert.ok(flat.includes(`msg${i}x`), `tail msg${i}x kept`);
});

test('re-fold when the tail crosses the threshold again: only new slice summarized', async () => {
    // watermark 9, 26 conv messages → tail 17 > 16 → fold to boundary 18
    const conv = mkConv(26);
    const opts = { ...OPTS, existingSummary: 'STORED-SUMMARY', summaryUpTo: 9 };

    assert.strictEqual(needsSummarization(conv, opts), true);
    const result = await compactMessages(conv, opts);

    assert.strictEqual(llmStub.calls.length, 1);
    assert.strictEqual(result.didSummarize, true);
    assert.strictEqual(result.summaryUpTo, 26 - RECENT_WINDOW); // 18

    // The summarizer input: seeded with the old summary, containing ONLY the
    // newly evicted slice [9, 18) — nothing already-folded, nothing recent.
    const prompt = llmStub.calls[0].messages.find(m => m.role === 'user').content;
    assert.ok(prompt.includes('Previous summary:\nSTORED-SUMMARY'));
    for (let i = 9; i < 18; i++) assert.ok(prompt.includes(`msg${i}x`), `newly evicted msg${i}x in prompt`);
    for (let i = 0; i < 9; i++) assert.ok(!prompt.includes(`msg${i}x`), `already-folded msg${i}x NOT in prompt`);
    for (let i = 18; i < 26; i++) assert.ok(!prompt.includes(`msg${i}x`), `recent msg${i}x NOT in prompt`);
});

test('stale watermark (≥ history length) invalidates summary', async () => {
    // Short passthrough case
    const short = mkConv(10);
    const shortOpts = { ...OPTS, existingSummary: 'STALE', summaryUpTo: 20 };
    assert.strictEqual(needsSummarization(short, shortOpts), false);
    const r1 = await compactMessages(short, shortOpts);
    assert.strictEqual(llmStub.calls.length, 0);
    assert.strictEqual(r1.newSummary, null, 'stale summary discarded');
    assert.strictEqual(r1.summaryUpTo, 0);
    assert.strictEqual(r1.messages.length, 10);

    // Long: full re-summarize from scratch, no seed
    const long = mkConv(20);
    const longOpts = { ...OPTS, existingSummary: 'STALE', summaryUpTo: 30 };
    assert.strictEqual(needsSummarization(long, longOpts), true);
    const r2 = await compactMessages(long, longOpts);
    assert.strictEqual(llmStub.calls.length, 1);
    const prompt = llmStub.calls[0].messages.find(m => m.role === 'user').content;
    assert.ok(!prompt.includes('Previous summary:'), 'no seed after invalidation');
    assert.strictEqual(r2.summaryUpTo, 20 - RECENT_WINDOW);
});

test('migration: existing summary without watermark folds once with seed', async () => {
    const conv = mkConv(17);
    const opts = { ...OPTS, existingSummary: 'PRE-FIX-SUMMARY' }; // summaryUpTo undefined
    const result = await compactMessages(conv, opts);

    assert.strictEqual(llmStub.calls.length, 1);
    const prompt = llmStub.calls[0].messages.find(m => m.role === 'user').content;
    assert.ok(prompt.includes('Previous summary:\nPRE-FIX-SUMMARY'));
    assert.strictEqual(result.summaryUpTo, 17 - RECENT_WINDOW);
});

test('skip path re-hoists attachments and images from the folded prefix', async () => {
    const conv = mkConv(19);
    conv[2] = {
        role: 'user',
        content: [
            { type: 'text', text: 'msg2x' },
            { type: 'image_url', image_url: { url: 'https://img.example/pic.png' } },
        ],
        attachments: [{
            name: 'doc.pdf', type: 'application/pdf',
            extractedText: 'FILE-CONTENT-ALPHA', storageKey: 'sk-123',
        }],
    };
    const opts = { ...OPTS, existingSummary: 'STORED-SUMMARY', summaryUpTo: 9 };
    const result = await compactMessages(conv, opts);

    assert.strictEqual(llmStub.calls.length, 0);
    const summaryMsg = summaryMessageOf(result);
    assert.ok(Array.isArray(summaryMsg.content), 'summary is multimodal');
    const texts = summaryMsg.content.filter(b => b.type === 'text').map(b => b.text);
    assert.ok(texts.some(t => t.includes('FILE-CONTENT-ALPHA')), 'file text re-injected without LLM call');
    assert.ok(summaryMsg.content.some(b => b.type === 'image_url' && b.image_url.url === 'https://img.example/pic.png'));
    // Sidecar carried forward with extractedText stripped but keys kept
    assert.ok(Array.isArray(summaryMsg.attachments));
    assert.strictEqual(summaryMsg.attachments[0].storageKey, 'sk-123');
    assert.strictEqual(summaryMsg.attachments[0].extractedText, undefined);
});

test('fold boundary walks past tool messages; watermark lands after them', async () => {
    const conv = mkConv(20);
    conv[11] = { role: 'assistant', content: 'msg11x', tool_calls: [{ id: 't1' }] };
    conv[12] = { role: 'tool', content: 'tool-result-12x' }; // naive boundary 20-8=12
    const result = await compactMessages(conv, { ...OPTS });

    assert.strictEqual(result.summaryUpTo, 13, 'boundary walked past the tool message');
    // First message after the summary/ack pair must not be an orphan tool result
    const ackIdx = result.messages.findIndex(m => m.role === 'assistant' && String(m.content).includes('context from our earlier conversation'));
    assert.notStrictEqual(result.messages[ackIdx + 1]?.role, 'tool');
});

test('summarizer failure: watermark does not advance, nothing dropped silently', async () => {
    const conv = mkConv(26);
    llmStub.failNext = true;
    const opts = { ...OPTS, existingSummary: 'STORED-SUMMARY', summaryUpTo: 9 };
    const result = await compactMessages(conv, opts);

    assert.strictEqual(result.didSummarize, false);
    assert.strictEqual(result.newSummary, 'STORED-SUMMARY', 'old summary kept');
    assert.strictEqual(result.summaryUpTo, 9, 'watermark frozen');
    const flat = JSON.stringify(result.messages);
    for (let i = 9; i < 26; i++) assert.ok(flat.includes(`msg${i}x`), `unsummarized msg${i}x stays verbatim`);
});

test('needsSummarization agrees with compactMessages across scenarios', async () => {
    const cases = [
        { conv: mkConv(16), opts: { ...OPTS } },
        { conv: mkConv(17), opts: { ...OPTS } },
        { conv: mkConv(19), opts: { ...OPTS, existingSummary: 'S', summaryUpTo: 9 } },
        { conv: mkConv(26), opts: { ...OPTS, existingSummary: 'S', summaryUpTo: 9 } },
        { conv: mkConv(10), opts: { ...OPTS, existingSummary: 'S', summaryUpTo: 20 } },
    ];
    for (const { conv, opts } of cases) {
        llmStub.calls = [];
        const predicted = needsSummarization(conv, opts);
        const result = await compactMessages(conv, opts);
        assert.strictEqual(result.didSummarize, predicted,
            `parity for conv=${conv.length} watermark=${opts.summaryUpTo ?? 0}`);
    }
});

test('system messages pass through untouched in every path', async () => {
    const sys = { role: 'system', content: 'SYSTEM-PROMPT' };
    for (const opts of [
        { ...OPTS },                                              // fold path (19 > threshold)
        { ...OPTS, existingSummary: 'S', summaryUpTo: 9 },        // skip path
    ]) {
        const conv = [sys, ...mkConv(19)];
        const result = await compactMessages(conv, opts);
        assert.strictEqual(result.messages[0].content, 'SYSTEM-PROMPT');
    }
});
