/**
 * BFSF-263 — <think> tag splitter unit tests.
 *
 * Pins the chunk-boundary safety (tags split mid-chunk stream correctly with
 * nothing dropped and no stalls), the start-of-turn-only rule (mid-content
 * literal tags are NOT treated as reasoning — code examples survive), the
 * unclosed-tag flush, the reasoning_content dedupe switch, and the
 * non-streaming extract/strip helpers.
 *
 * Run: cd server && node --test core/providers/thinkTagStream.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createThinkTagSplitter, extractThinkBlocks, stripThinkTags } = require('./thinkTagStream');

// Drive the splitter with chunk boundaries at every position to prove
// boundary-independence: same result no matter how the text is sliced.
function runSplit(chunks) {
    const out = { text: '', thinking: '', starts: 0, stops: 0 };
    const s = createThinkTagSplitter({
        onText: (t) => { out.text += t; },
        onThinking: (t) => { out.thinking += t; },
        onThinkingStart: () => { out.starts++; },
        onThinkingStop: () => { out.stops++; },
    });
    for (const c of chunks) s.push(c);
    s.flush();
    return out;
}

test('leading <think> block splits into thinking + clean text', () => {
    const r = runSplit(['<think>plan the answer</think>Hello Tom!']);
    assert.strictEqual(r.thinking, 'plan the answer');
    assert.strictEqual(r.text, 'Hello Tom!');
    assert.strictEqual(r.starts, 1);
    assert.strictEqual(r.stops, 1);
});

test('<thinking> variant and leading whitespace are handled; whitespace swallowed', () => {
    const r = runSplit(['\n  <thinking>hmm</thinking>Answer.']);
    assert.strictEqual(r.thinking, 'hmm');
    assert.strictEqual(r.text, 'Answer.');
});

test('tags split across chunk boundaries at EVERY position (nothing dropped, no stall)', () => {
    const full = '<think>internal reasoning here</think>The visible answer.';
    for (let i = 1; i < full.length - 1; i++) {
        const r = runSplit([full.slice(0, i), full.slice(i)]);
        assert.strictEqual(r.thinking, 'internal reasoning here', `split at ${i}`);
        assert.strictEqual(r.text, 'The visible answer.', `split at ${i}`);
    }
});

test('one-char-at-a-time streaming works too', () => {
    const full = ' <thinking>deep\nthought</thinking>Done thinking.';
    const r = runSplit([...full]);
    assert.strictEqual(r.thinking, 'deep\nthought');
    assert.strictEqual(r.text, 'Done thinking.');
});

test('mid-content <think> is NOT reasoning (start-of-turn rule — code examples survive)', () => {
    const r = runSplit(['Here is an example: ', '<think>not reasoning</think>', ' done']);
    assert.strictEqual(r.thinking, '');
    assert.strictEqual(r.text, 'Here is an example: <think>not reasoning</think> done');
});

test('unclosed <think> runs to end-of-stream as reasoning (flush)', () => {
    const r = runSplit(['<think>never closes ', 'and keeps going']);
    assert.strictEqual(r.thinking, 'never closes and keeps going');
    assert.strictEqual(r.text, '');
    assert.strictEqual(r.stops, 1, 'flush closes the part');
});

test('a turn ending mid-partial-open-tag flushes it as text', () => {
    const r = runSplit(['<thin']);
    assert.strictEqual(r.text, '<thin');
    assert.strictEqual(r.thinking, '');
});

test('lookalike close tag inside reasoning is kept as reasoning', () => {
    const r = runSplit(['<think>we use </thinker> here</think>ok']);
    assert.strictEqual(r.thinking, 'we use </thinker> here');
    assert.strictEqual(r.text, 'ok');
});

test('plain text without tags passes through untouched', () => {
    const r = runSplit(['Hello ', 'world', ' — no tags.']);
    assert.strictEqual(r.text, 'Hello world — no tags.');
    assert.strictEqual(r.thinking, '');
    assert.strictEqual(r.starts, 0);
});

test('disableTagDetection: buffered prefix flushes as text; later pushes pass through', () => {
    const out = { text: '', thinking: '' };
    const s = createThinkTagSplitter({
        onText: (t) => { out.text += t; },
        onThinking: (t) => { out.thinking += t; },
    });
    s.push('<thin'); // would normally wait as a potential open tag
    s.disableTagDetection(); // reasoning_content arrived — tags are literal
    s.push('k>literal');
    s.flush();
    assert.strictEqual(out.text, '<think>literal');
    assert.strictEqual(out.thinking, '');
});

// ── Non-streaming helpers ────────────────────────────────────────────

test('extractThinkBlocks: complete pairs anywhere + leading unclosed block', () => {
    let r = extractThinkBlocks('<think>a</think>Answer<thinking>b</thinking> tail');
    assert.strictEqual(r.content, 'Answer tail');
    assert.strictEqual(r.thinking, 'a\nb');

    r = extractThinkBlocks('<think>truncated reasoning never closed');
    assert.strictEqual(r.content, '');
    assert.strictEqual(r.thinking, 'truncated reasoning never closed');

    r = extractThinkBlocks('no tags at all');
    assert.strictEqual(r.content, 'no tags at all');
    assert.strictEqual(r.thinking, null);
});

test('stripThinkTags leaves mid-content UNCLOSED tags alone (likely literal text)', () => {
    const s = 'The syntax is <think> followed by text';
    assert.strictEqual(stripThinkTags(s), s);
});

// ── Gemma 4's thought CHANNEL ────────────────────────────────────────────────
// `<|channel>thought … <channel|>` rather than a tag pair, and an EMPTY channel
// is how its template says "thinking is off". Before this was understood, a
// builder turn rendered the model's whole deliberation as the visible answer.

test("Gemma's thought channel splits into thinking + clean text", () => {
    const r = runSplit(['<|channel>thought\nweigh the options\n<channel|>Here is the plan.']);
    // Whitespace before the first real word is swallowed (see the empty-marker
    // test below); everything after it is kept verbatim.
    assert.strictEqual(r.thinking, 'weigh the options\n');
    assert.strictEqual(r.text, 'Here is the plan.');
    assert.strictEqual(r.starts, 1);
    assert.strictEqual(r.stops, 1);
});

test("Gemma's EMPTY channel (thinking off) yields no thinking block at all", () => {
    const r = runSplit(['<|channel>thought\n<channel|>Straight to the answer.']);
    assert.strictEqual(r.thinking, '');
    assert.strictEqual(r.text, 'Straight to the answer.');
    // The marker is consumed, but an empty Thinking… bubble must never open.
    assert.strictEqual(r.starts, 0);
    assert.strictEqual(r.stops, 0);
});

test('the channel survives any chunk boundary', () => {
    const whole = '<|channel>thought\nstep one\nstep two\n<channel|>Done.';
    for (let i = 1; i < whole.length; i++) {
        const r = runSplit([whole.slice(0, i), whole.slice(i)]);
        assert.strictEqual(r.text, 'Done.', `split at ${i}`);
        assert.strictEqual(r.thinking, 'step one\nstep two\n', `split at ${i}`);
    }
});

test('an unclosed channel runs to end-of-stream as reasoning', () => {
    const r = runSplit(['<|channel>thought\nran out of tokens mid-thought']);
    assert.strictEqual(r.thinking, 'ran out of tokens mid-thought');
    assert.strictEqual(r.text, '');
    assert.strictEqual(r.stops, 1);
});

test('a channel marker mid-answer is text, like every other syntax', () => {
    const r = runSplit(['The template writes <|channel>thought here.']);
    assert.strictEqual(r.text, 'The template writes <|channel>thought here.');
    assert.strictEqual(r.thinking, '');
    assert.strictEqual(r.starts, 0);
});

test('the two syntaxes do not cross-close', () => {
    // A turn opened with <think> is not ended by a channel close, and vice versa.
    const a = runSplit(['<think>reasoning<channel|>still reasoning</think>Answer.']);
    assert.strictEqual(a.thinking, 'reasoning<channel|>still reasoning');
    assert.strictEqual(a.text, 'Answer.');
    const b = runSplit(['<|channel>thought reasoning</think> still reasoning<channel|>Answer.']);
    assert.strictEqual(b.thinking, 'reasoning</think> still reasoning');
    assert.strictEqual(b.text, 'Answer.');
});

test('extractThinkBlocks handles the channel form and the empty marker', () => {
    const one = extractThinkBlocks('<|channel>thought\nweighing\n<channel|>The answer.');
    assert.strictEqual(one.thinking, 'weighing');
    assert.strictEqual(one.content, 'The answer.');

    // Empty channel: the marker goes, but there is no reasoning to report.
    const empty = extractThinkBlocks('<|channel>thought\n<channel|>The answer.');
    assert.strictEqual(empty.thinking, null);

    // Unclosed leading channel — the whole message was reasoning.
    const open = extractThinkBlocks('<|channel>thought\nstill going');
    assert.strictEqual(open.thinking, 'still going');
    assert.strictEqual(open.content, '');

    assert.strictEqual(stripThinkTags('<|channel>thought\nx\n<channel|>Clean.'), 'Clean.');
    // Text that merely mentions the marker is untouched.
    assert.strictEqual(stripThinkTags('no markers here'), 'no markers here');
});
