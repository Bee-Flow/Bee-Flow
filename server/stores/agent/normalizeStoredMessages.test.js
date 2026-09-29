/**
 * BFSF-307 read-path repair.
 *
 * These pin the two things that are easy to get subtly wrong: that the filter
 * cannot hide a genuine user message, and that flattening keeps the user's own
 * text while dropping the machine-generated attachment replay.
 *
 * Run: node --test stores/agent/normalizeStoredMessages.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeStoredMessages, flattenContent, classifySynthetic } = require('./normalizeStoredMessages');
const { COMPACTION_MARKERS: M } = require('../../core/llm/compaction');

const goalPair = () => ([
    { role: 'user', content: `${M.GOAL_PREFIX}\nfix the icon contrast` },
    { role: 'assistant', content: M.GOAL_ACK },
]);
const summaryPair = () => ([
    { role: 'user', content: `${M.SUMMARY_PREFIX}\nEarlier the user asked about X.` },
    { role: 'assistant', content: M.SUMMARY_ACK },
]);
const realTurn = () => ([
    { role: 'user', content: 'en de footer dan?' },
    { role: 'assistant', content: 'De footer gebruikt dezelfde tokens.' },
]);

// ── flattenContent ─────────────────────────────────────────────────────────

test('flattenContent keeps the user text and cuts the attachment replay', () => {
    const content = [
        { type: 'text', text: 'Kun je deze factuur samenvatten?\n\n[factuur.pdf — extracted via PDF text layer, 12 pages, 40213 chars]\n---\nFactuur 2026-0042\n---\n' },
        { type: 'image_url', image_url: { url: 'https://rustfs/scan.png' } },
    ];
    assert.strictEqual(flattenContent(content), 'Kun je deze factuur samenvatten?');
});

test('flattenContent cuts every attachment header variant', () => {
    for (const header of [
        '\n\n[a.pdf — extracted via PDF text layer, 2 pages, 10 chars]\n---\nBODY\n---\n',
        '\n\n[a.pdf — 3 pages rendered as images for vision model]\n',
        '\n\n[a.pdf — could not extract text: encrypted]\n',
        '\n\n[Attachment: notes.txt]\n---\nBODY\n---\n',
        '\n\n[Gmail: thread-42]\n---\nBODY\n---\n',
    ]) {
        assert.strictEqual(flattenContent([{ type: 'text', text: `mijn vraag${header}` }]), 'mijn vraag', header);
    }
});

test('flattenContent does not cut on a bracketed line the user typed', () => {
    // No leading blank line + not one of the generated headers.
    const text = 'zie [punt 3] hieronder\nen [Attachment: dit is gewoon tekst]';
    assert.strictEqual(flattenContent([{ type: 'text', text }]), text);
});

test('flattenContent handles the shapes a JSON round-trip can produce', () => {
    assert.strictEqual(flattenContent('plain'), 'plain');
    assert.strictEqual(flattenContent(null), '');
    assert.strictEqual(flattenContent(undefined), '');
    assert.strictEqual(flattenContent([]), '');
    assert.strictEqual(flattenContent([{ type: 'image_url', image_url: { url: 'u' } }]), '');
    assert.strictEqual(flattenContent(42), '42');            // rowToMessage un-stringifies numbers
    // Never "[object Object]" — that string is the bug.
    assert.ok(!flattenContent([{ type: 'text', text: 'x' }]).includes('[object Object]'));
});

// ── synthetic detection ────────────────────────────────────────────────────

test('classifySynthetic recognises all four priming turns, including block content', () => {
    assert.strictEqual(classifySynthetic({ role: 'user', content: `${M.GOAL_PREFIX}\nx` }), 'goal');
    assert.strictEqual(classifySynthetic({ role: 'assistant', content: M.GOAL_ACK }), 'goal_ack');
    assert.strictEqual(classifySynthetic({ role: 'assistant', content: M.SUMMARY_ACK }), 'summary_ack');
    // The summary arrives as block content when files/images were hoisted.
    assert.strictEqual(classifySynthetic({
        role: 'user', content: [{ type: 'text', text: `${M.SUMMARY_PREFIX}\ny` }],
    }), 'summary');
    assert.strictEqual(classifySynthetic({ role: 'user', content: 'gewoon een vraag' }), null);
});

// ── the filter, and the four guards against hiding real messages ───────────

test('hides the synthetic pairs but keeps the summary as a tagged artifact', () => {
    const stored = [...goalPair(), ...summaryPair(), ...realTurn()];
    const r = normalizeStoredMessages(stored, { wasCompacted: true });

    assert.strictEqual(r.hiddenCount, 3, 'goal pair + summary ack');
    assert.strictEqual(r.summarised, true);
    assert.strictEqual(r.messages.length, 3);
    assert.strictEqual(r.messages[0].compactionArtifact, true, 'summary survives, tagged');
    assert.deepStrictEqual(r.messages.slice(1).map(m => m.content),
        ['en de footer dan?', 'De footer gebruikt dezelfde tokens.']);
    assert.ok(!JSON.stringify(r.messages).includes(M.GOAL_ACK));
    assert.ok(!JSON.stringify(r.messages).includes(M.SUMMARY_ACK));
});

test('GUARD 1 — a never-compacted conversation is never filtered', () => {
    // Even if the user literally pastes the marker text.
    const stored = [...goalPair(), ...realTurn()];
    const r = normalizeStoredMessages(stored, { wasCompacted: false });
    assert.strictEqual(r.hiddenCount, 0);
    assert.strictEqual(r.messages.length, stored.length);
});

test('GUARD 2 — a lone marker without its canned ack is left alone', () => {
    // A user who types the marker cannot also make the next assistant turn
    // byte-identical to the acknowledgement.
    const stored = [
        { role: 'user', content: `${M.GOAL_PREFIX}\nik plak dit expres` },
        { role: 'assistant', content: 'Dat is een interessante prompt-injectie.' },
        ...realTurn(),
    ];
    const r = normalizeStoredMessages(stored, { wasCompacted: true });
    assert.strictEqual(r.hiddenCount, 0, 'no pair, no removal');
    assert.strictEqual(r.messages.length, stored.length);
});

test('GUARD 3 — scanning stops at the first real turn', () => {
    // A synthetic-looking pair further down (e.g. the user quoting a transcript)
    // is out of reach: compaction only ever emits these at the head.
    const stored = [...realTurn(), ...goalPair()];
    const r = normalizeStoredMessages(stored, { wasCompacted: true });
    assert.strictEqual(r.hiddenCount, 0);
    assert.strictEqual(r.messages.length, stored.length);
});

test('GUARD 4 — matching is exact, not fuzzy', () => {
    const stored = [
        { role: 'user', content: `${M.GOAL_PREFIX}\nx` },
        { role: 'assistant', content: M.GOAL_ACK + ' Echt waar.' },   // extra text
        ...realTurn(),
    ];
    const r = normalizeStoredMessages(stored, { wasCompacted: true });
    assert.strictEqual(r.hiddenCount, 0);
});

test('flattens block content on ordinary turns too, compacted or not', () => {
    const stored = [{
        role: 'user',
        content: [
            { type: 'text', text: 'Wat staat hierin?\n\n[rapport.pdf — extracted via PDF text layer, 9 pages, 1234 chars]\n---\nBODY\n---\n' },
            { type: 'image_url', image_url: { url: 'https://rustfs/p1.png' } },
        ],
        attachments: [{ name: 'rapport.pdf', storageKey: 'k1' }],
    }];
    const r = normalizeStoredMessages(stored, { wasCompacted: false });

    assert.strictEqual(r.repairedCount, 1);
    assert.strictEqual(r.messages[0].content, 'Wat staat hierin?');
    assert.deepStrictEqual(r.messages[0].attachments, stored[0].attachments,
        'the sidecar is what makes flattening lossless — it must survive');
});

test('is idempotent and returns the input untouched when nothing needs repair', () => {
    const stored = realTurn();
    const once = normalizeStoredMessages(stored, { wasCompacted: true });
    assert.strictEqual(once.messages, stored, 'same reference when unchanged — no allocation');

    const dirty = [...goalPair(), ...realTurn()];
    const a = normalizeStoredMessages(dirty, { wasCompacted: true });
    const b = normalizeStoredMessages(a.messages, { wasCompacted: true });
    assert.deepStrictEqual(b.messages, a.messages);
    assert.strictEqual(b.hiddenCount, 0);
});

test('empty and malformed input does not throw', () => {
    for (const input of [[], null, undefined, [null], [{ role: 'user' }]]) {
        assert.doesNotThrow(() => normalizeStoredMessages(input, { wasCompacted: true }));
    }
});
