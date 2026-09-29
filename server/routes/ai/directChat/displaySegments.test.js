/**
 * BFSF-261 — direct-chat display-segment joining.
 *
 * Pins: the lazy separator fires exactly once and only before the FIRST
 * visible text of a follow-up round (never after tool-only/muted rounds, so
 * no stray blank paragraphs), and joinFinal() makes persistence match the
 * live stream (pre-fix the pre-tool preamble was dropped on save/reload —
 * and the live view glued "…anything." + "Good, I have…" together).
 *
 * Run: cd server && node --test routes/ai/directChat/displaySegments.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createDisplaySegments } = require('./displaySegments');

function harness() {
    const events = [];
    const send = (type, data) => events.push({ type, ...data });
    const rawSink = (text) => { if (text) send('content', { text }); };
    const seg = createDisplaySegments();
    const wrapped = seg.wrapStreamContent(rawSink, send);
    const streamedText = () => events.filter(e => e.type === 'content').map(e => e.text).join('');
    return { seg, wrapped, rawSink, streamedText };
}

test('separator lands exactly once, before the first visible text of the next round', () => {
    const { seg, wrapped, rawSink, streamedText } = harness();

    // Round 1 (primary stream — unwrapped sink).
    rawSink('Ik zoek het even voor je op. Ik vond niet direct iets bijzonders.');
    seg.onRoundEnd('Ik zoek het even voor je op. Ik vond niet direct iets bijzonders.');

    // Round 2 (follow-up — wrapped sink), streamed in chunks.
    wrapped('Goed,');
    wrapped(' ik heb het gevonden.');

    assert.strictEqual(
        streamedText(),
        'Ik zoek het even voor je op. Ik vond niet direct iets bijzonders.\n\nGoed, ik heb het gevonden.',
        'the reported "…iets bijzonders.Goed, ik heb…" glue is gone — and only ONE separator'
    );
});

test('tool-only / muted rounds never arm the separator (no stray blank paragraphs)', () => {
    const { seg, wrapped, streamedText } = harness();

    seg.onRoundEnd('');        // muted pipeline round — no visible text
    seg.onRoundEnd('   \n');   // whitespace-only — same
    wrapped('The answer.');

    assert.strictEqual(streamedText(), 'The answer.', 'no leading \\n\\n');
});

test('multi-round: each visible round is separated; persistence matches the stream', () => {
    const { seg, wrapped, rawSink, streamedText } = harness();

    rawSink('Round one.');
    seg.onRoundEnd('Round one.');
    wrapped('Round two.');
    seg.onRoundEnd('Round two.');
    wrapped('Final.');

    assert.strictEqual(streamedText(), 'Round one.\n\nRound two.\n\nFinal.');
    assert.strictEqual(seg.joinFinal('Final.'), 'Round one.\n\nRound two.\n\nFinal.',
        'stored content identical to what was streamed');
});

test('joinFinal without earlier segments returns the final text untouched', () => {
    const seg = createDisplaySegments();
    assert.strictEqual(seg.hasSegments(), false);
    assert.strictEqual(seg.joinFinal('Only round.'), 'Only round.');
    assert.strictEqual(seg.joinFinal(''), '', 'empty stays empty (Done ✓ fallback unaffected)');
});

test('a follow-up retry that re-streams does not double-record (onRoundEnd only at real boundaries)', () => {
    const { seg, wrapped } = harness();
    seg.onRoundEnd('Preamble.');
    // Retry path resets fullContent WITHOUT calling onRoundEnd again.
    wrapped('Attempt text');
    assert.strictEqual(seg.joinFinal('Final answer.'), 'Preamble.\n\nFinal answer.',
        'only real round boundaries are recorded');
});
