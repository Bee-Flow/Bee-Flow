/**
 * The one-line label under "What the AI took from it".
 *
 * It runs inside the ingest of every document, on a model call that can be
 * slow, absent or misconfigured — so the assertions are mostly about it NOT
 * mattering when it fails. A summary is a nicety; the document is the point.
 *
 * Run: node --test --test-force-exit core/kb/extractSummary.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { summarise, normalise, withOverlap, PREFIX_CHARS, MAX_SUMMARY_CHARS } = require('./extractSummary');

const TEXT = 'Payment terms are 30 days from the date of invoice. Quotes remain valid for 30 days. '
    + 'Warranty covers 12 years on the product and 25 years on yield. Cancellation is free up to 14 days.';

/** Distinguishes "the test passed undefined" from "the test passed nothing". */
const UNDEF = Symbol('undefined');

const DEFAULT_STRUCTURED = { summary: 'Payment terms, 30-day validity, warranty' };

// `structured` is compared against a sentinel rather than defaulted with `??`,
// so a test can hand in null or undefined ON PURPOSE — which is exactly what
// a model returning nothing usable looks like.
function deps({ structured = DEFAULT_STRUCTURED, chat, model = 'fast-model' } = {}) {
    const calls = { chat: [] };
    return {
        calls,
        deps: {
            resolveAgentModel: async () => model,
            getAIConfig: async () => ({}),
            llmClient: {
                chatForcedTool: async (modelId, messages, tool, opts) => {
                    calls.chat.push({ modelId, messages, tool, opts });
                    if (typeof chat === 'function') return chat({ modelId, messages });
                    return { structured: structured === UNDEF ? undefined : structured };
                },
            },
        },
    };
}

test('summarises what the document is about', async () => {
    const { deps: d } = deps();
    const r = await summarise({ text: TEXT, title: 'Terms 2026.pdf', deps: d });
    assert.deepStrictEqual(r, { summary: 'Payment terms, 30-day validity, warranty', topics: [] });
});

test('only the first few thousand characters are sent', async () => {
    // A 400-page PDF summarised in full would cost more than embedding it did.
    const { deps: d, calls } = deps();
    await summarise({ text: 'x'.repeat(PREFIX_CHARS * 3), deps: d });
    const userMsg = calls.chat[0].messages.find(m => m.role === 'user');
    assert.ok(userMsg.content.length < PREFIX_CHARS + 200, 'the prefix, plus a short header');
});

test('runs on the fast tier — this is a label, not an answer', async () => {
    const seen = [];
    const d = {
        resolveAgentModel: async (tier) => { seen.push(tier); return 'fast-model'; },
        getAIConfig: async () => ({}),
        llmClient: { chatForcedTool: async () => ({ structured: { summary: 'x' } }) },
    };
    await summarise({ text: TEXT, deps: d });
    assert.deepStrictEqual(seen, ['tier:fast']);
});

test('is told to answer in the org’s language', async () => {
    const { deps: d, calls } = deps();
    await summarise({ text: TEXT, language: 'Dutch', deps: d });
    const sys = calls.chat[0].messages.find(m => m.role === 'system').content;
    assert.match(sys, /Dutch/);
});

test('is told never to repeat personal details it finds', async () => {
    // The column sits next to a shield icon claiming personal data was
    // removed. A summary that quotes the name undoes that claim on screen.
    const { deps: d, calls } = deps();
    await summarise({ text: TEXT, deps: d });
    const sys = calls.chat[0].messages.find(m => m.role === 'system').content;
    assert.match(sys, /never repeat names/i);
    assert.match(sys, /\[person_1\]/, 'and that placeholders are redactions, not content');
});

test('a model that produces nothing usable yields no summary, not a crash', async () => {
    for (const structured of [null, undefined, {}, { summary: '' }, { summary: '   ' }, { summary: 42 }, 'nope']) {
        const { deps: d } = deps({ structured: structured === undefined ? UNDEF : structured });
        assert.strictEqual(await summarise({ text: TEXT, deps: d }), null, JSON.stringify(structured));
    }
});

test('a provider that is not configured yields no summary', async () => {
    const d = {
        resolveAgentModel: async () => null,
        getAIConfig: async () => ({}),
        llmClient: { chatForcedTool: async () => { throw new Error('should not be called'); } },
    };
    assert.strictEqual(await summarise({ text: TEXT, deps: d }), null);
});

test('a model call that throws yields no summary, and the ingest continues', async () => {
    const { deps: d } = deps({ chat: () => { throw new Error('rate limited'); } });
    assert.strictEqual(await summarise({ text: TEXT, deps: d }), null);
});

test('a document too short to be about anything is not sent at all', async () => {
    const { deps: d, calls } = deps();
    assert.strictEqual(await summarise({ text: 'Hello.', deps: d }), null);
    assert.strictEqual(await summarise({ text: '', deps: d }), null);
    assert.strictEqual(await summarise({ deps: d }), null);
    assert.strictEqual(calls.chat.length, 0);
});

describe_normalise();
function describe_normalise() {
    test('model output is treated as untrusted, not as schema-guaranteed', () => {
        // A 4000-character "summary" in a 1.2fr table column breaks the row.
        const long = normalise({ summary: 'a'.repeat(4000) });
        assert.strictEqual(long.summary.length, MAX_SUMMARY_CHARS);

        // Topics: strings only, trimmed, capped in length and in number.
        const t = normalise({ summary: 'ok', topics: ['a', '  b  ', 42, null, 'c', 'd', 'e', 'f', 'x'.repeat(200)] });
        assert.deepStrictEqual(t.topics, ['a', 'b', 'c', 'd', 'e']);

        assert.deepStrictEqual(normalise({ summary: 'ok', topics: 'not an array' }).topics, []);
        assert.strictEqual(normalise({ topics: ['a'] }), null, 'topics without a summary is not a summary');
    });
}

describe_overlap();
function describe_overlap() {
    test('a cross-source duplicate is annotated rather than hidden', () => {
        // A price list can legitimately arrive as a spreadsheet AND a table.
        assert.strictEqual(
            withOverlap('212 articles with prices', 'table Price list'),
            '212 articles with prices · overlaps with table Price list',
        );
        // The note stands alone when there is no summary to hang it on.
        assert.strictEqual(withOverlap('', 'table Price list'), 'overlaps with table Price list');
        assert.strictEqual(withOverlap(null, 'table Price list'), 'overlaps with table Price list');
        // And no note when nothing overlaps.
        assert.strictEqual(withOverlap('212 articles with prices', null), '212 articles with prices');
        assert.strictEqual(withOverlap('', null), null);
    });
}
