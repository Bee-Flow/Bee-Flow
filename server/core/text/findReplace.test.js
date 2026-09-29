/**
 * The find/replace engine behind webpage_file_replace and document_edit.
 *
 * It arrived here by extraction from integrations/webpageDocTools.js, where it
 * had no tests at all — so this file is not only cover for the new caller, it is
 * the first cover the old one has ever had. The extraction itself was proven
 * equivalent by running both module versions over the same cases; what is
 * tested here is the behaviour both callers now depend on.
 *
 * Pure functions, no I/O.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
    applyFindReplace, findAllOccurrences, lineNumberForOffset,
    locateOriginalRange, normalizeWhitespace, spliceAt, truncate,
} = require('./findReplace');

const DOC = [
    '<h1 class="title">Factuur</h1>',
    '<table class="lines">',
    '  <tr><td>Advies</td><td>1.140,00</td></tr>',
    '  <tr><td>Staal</td><td>4.440,00</td></tr>',
    '</table>',
].join('\n');

const OPTS = { label: 'The document body', readHint: 'Call document_read({ documentId })' };

// ── The ladder ───────────────────────────────────────────────────────

test('rung 1 — one verbatim hit is replaced, and the line number is reported', () => {
    const out = applyFindReplace(DOC, { ...OPTS, findText: '1.140,00', replaceText: '1.320,00' });
    assert.ok(!out.error);
    assert.match(out.content, /1\.320,00/);
    assert.ok(!out.content.includes('1.140,00'));
    assert.match(out.message, /line 3/, 'the user can see WHERE it changed');
    // Everything else is byte-identical — that is the whole point of editing
    // rather than rewriting.
    assert.strictEqual(out.content.replace('1.320,00', '1.140,00'), DOC);
});

test('rung 2 — several hits REFUSE rather than guess, and name the lines', () => {
    // Guessing which occurrence was meant is how you change the wrong invoice
    // line, which is the one mistake nobody catches before sending.
    const out = applyFindReplace(DOC, { ...OPTS, findText: '<tr><td>', replaceText: '<tr><td class="c">' });
    assert.ok(out.error);
    assert.match(out.error, /matches 2 places/);
    assert.match(out.error, /lines 3, 4/);
    assert.match(out.error, /replace_all/, 'and says how to proceed on purpose');
});

test('rung 2 — replace_all replaces every occurrence, back to front', () => {
    // Back-to-front matters: splicing front-to-back invalidates the offsets of
    // every later hit, which silently corrupts the tail of the document.
    const out = applyFindReplace(DOC, { ...OPTS, findText: '<tr><td>', replaceText: '<tr><td class="c">', replaceAll: true });
    assert.ok(!out.error);
    assert.strictEqual((out.content.match(/class="c"/g) || []).length, 2);
    assert.match(out.content, /Advies/);
    assert.match(out.content, /Staal/);
});

test('rung 3 — a snippet that differs only in whitespace still matches', () => {
    // A model that copied a snippet out of an earlier message has usually
    // collapsed the newlines. Failing there is a retry loop with no new
    // information in it.
    const multiline = 'line one\n    line two';
    const text = `before\n${multiline}\nafter`;
    const out = applyFindReplace(text, { ...OPTS, findText: 'line one line two', replaceText: 'REPLACED' });
    assert.ok(!out.error, out.error);
    assert.match(out.content, /REPLACED/);
    assert.match(out.message, /whitespace-normalized/);
});

test('rung 4 — a near miss returns a diff-style hint, not just "not found"', () => {
    // The hint probes on the first four WORDS, so it fires when the model has
    // the right sentence and the wrong detail — which is the common near miss:
    // it remembers the line but not the number the user has since corrected.
    const text = '<p>Bedrag inclusief btw bedraagt 1.140,00 euro</p>';
    const out = applyFindReplace(text, {
        ...OPTS,
        findText: 'Bedrag inclusief btw bedraagt 9.999,00 euro',
        replaceText: 'x',
    });
    assert.ok(out.error);
    assert.match(out.error, /closest match is at line 1/);
    assert.match(out.error, /- Bedrag inclusief btw bedraagt 9\.999,00 euro/, 'what was looked for');
    assert.match(out.error, /\+ .*1\.140,00/, 'what is actually there');
    assert.match(out.error, /verbatim as your next find_text/);
});

test('rung 4 — nothing even close points at the read tool', () => {
    const out = applyFindReplace(DOC, { ...OPTS, findText: 'zzz nothing like this zzz', replaceText: 'x' });
    assert.ok(out.error);
    assert.match(out.error, /No similar snippet found/);
    assert.match(out.error, /document_read/, 'the hint names the caller\'s own read tool');
});

// ── Insert and delete ────────────────────────────────────────────────

test('deleting is replace_text: ""', () => {
    const out = applyFindReplace(DOC, { ...OPTS, findText: '  <tr><td>Staal</td><td>4.440,00</td></tr>\n', replaceText: '' });
    assert.ok(!out.error);
    assert.ok(!out.content.includes('Staal'));
    assert.match(out.content, /Advies/, 'only that line went');
    assert.match(out.message, /removed/);
});

test('inserting is anchoring on a snippet and repeating it', () => {
    const out = applyFindReplace(DOC, {
        ...OPTS,
        findText: '</table>',
        replaceText: '  <tr><td>Transport</td><td>180,00</td></tr>\n</table>',
    });
    assert.ok(!out.error);
    assert.match(out.content, /Transport/);
    assert.match(out.content, /<\/table>/);
    assert.match(out.content, /Staal[\s\S]*Transport/, 'the new row lands in the right place');
});

// ── Refusals ─────────────────────────────────────────────────────────

test('an empty find_text is refused rather than matching everything', () => {
    const out = applyFindReplace(DOC, { ...OPTS, findText: '', replaceText: 'x' });
    assert.match(out.error, /find_text is required/);
});

test('editing an empty slot says so instead of erroring obscurely', () => {
    const out = applyFindReplace('', { ...OPTS, findText: 'a', replaceText: 'b' });
    assert.match(out.error, /is empty/);
});

test('the label the caller supplies is what the user reads', () => {
    // The same engine says "index.html" to a webpage tool and "The stylesheet"
    // to a document tool; neither knows about the other's vocabulary.
    const out = applyFindReplace('.a{}', { label: 'The stylesheet', readHint: 'Call document_read()', findText: 'zzz', replaceText: 'x' });
    assert.match(out.error, /The stylesheet/);
});

// ── The primitives ───────────────────────────────────────────────────

test('findAllOccurrences does not overlap, and reports 1-indexed lines', () => {
    assert.deepStrictEqual(
        findAllOccurrences('aaaa', 'aa').map(o => o.start),
        [0, 2],
        'advances past each hit rather than finding a third at offset 1',
    );
    assert.deepStrictEqual(findAllOccurrences('x', ''), [], 'an empty needle matches nothing');
    assert.strictEqual(findAllOccurrences('a\nb\nc', 'c')[0].line, 3);
});

test('lineNumberForOffset counts newlines before the offset', () => {
    assert.strictEqual(lineNumberForOffset('a\nb\nc', 0), 1);
    assert.strictEqual(lineNumberForOffset('a\nb\nc', 2), 2);
    assert.strictEqual(lineNumberForOffset('a\nb\nc', 4), 3);
});

test('locateOriginalRange maps a normalised hit back to real offsets', () => {
    const original = 'aaa   <b>\n  hello  </b> zzz';
    const range = locateOriginalRange(original, '<b> hello </b>');
    assert.ok(range, 'found');
    assert.strictEqual(original.slice(range.start, range.end).replace(/\s+/g, ' '), '<b> hello </b>');
    assert.strictEqual(locateOriginalRange(original, 'not here'), null);
});

test('the small helpers behave', () => {
    assert.strictEqual(spliceAt('abcdef', 2, 4, 'XY'), 'abXYef');
    assert.strictEqual(truncate('abcdef', 3), 'abc…');
    assert.strictEqual(truncate('ab', 5), 'ab');
    assert.strictEqual(truncate(null, 5), '');
    assert.strictEqual(normalizeWhitespace('  a \n\t b  '), 'a b');
});

// ── The property that makes this safe for hand-edited documents ──────

test('an edit against text the user has since changed FAILS rather than clobbering', () => {
    // This is the whole reason document_edit exists instead of a full rewrite.
    // The user corrected the amount by hand; the model still thinks it is the
    // old one. The edit must not land.
    const handEdited = DOC.replace('1.140,00', '1.250,00');
    const out = applyFindReplace(handEdited, { ...OPTS, findText: '1.140,00', replaceText: '1.320,00' });
    assert.ok(out.error, 'refused');
    assert.match(handEdited, /1\.250,00/, "the user's correction is untouched");
});
