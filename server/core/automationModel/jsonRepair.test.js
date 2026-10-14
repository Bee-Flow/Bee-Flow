/**
 * jsonRepair — rescuing the JSON a model very nearly wrote.
 *
 * The case that produced this file: an ai_step asked for
 * `{titel, markdown, samenvatting}` where `markdown` is a two-page
 * financieringsmemorandum. The model returned a complete, correct object whose
 * markdown value contained literal newlines — so JSON.parse threw, the step
 * failed, and a document that had already been written was thrown away.
 *
 * Run: node --test --test-force-exit automation/jsonRepair.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseJsonish, stripFence, escapeControlChars } = require('./jsonRepair');

// ── The case this exists for ──────────────────────────────────────────────

test('a document with literal newlines inside its string value is rescued', () => {
    const raw = '{"titel": "Memorandum", "markdown": "# Kop\n\nEen alinea.\n\n| A | B |\n|---|---|\n| 1 | 2 |\n"}';
    const r = parseJsonish(raw);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.repaired, true, 'the rescue was needed');
    assert.strictEqual(r.value.titel, 'Memorandum');
    assert.match(r.value.markdown, /# Kop/);
    assert.match(r.value.markdown, /\| 1 \| 2 \|/);
    assert.ok(r.value.markdown.includes('\n'), 'the newlines survive as real newlines');
});

test('the same thing inside a ```json fence', () => {
    const raw = '```json\n{"markdown": "Regel een\nRegel twee"}\n```';
    const r = parseJsonish(raw);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.markdown, 'Regel een\nRegel twee');
});

test('tabs and other control characters are escaped, never dropped', () => {
    const raw = '{"a": "kolom\tkolom", "b": "bel\u0007"}';
    const r = parseJsonish(raw);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.a, 'kolom\tkolom');
    assert.strictEqual(r.value.b, 'bel\u0007', 'a byte of someone\'s text is never silently deleted');
});

test('a trailing comma before a closer is dropped', () => {
    assert.deepStrictEqual(parseJsonish('{"a": 1, "b": [1, 2,],}').value, { a: 1, b: [1, 2] });
});

// ── Valid JSON must come through untouched, and unrepaired ────────────────

test('well-formed JSON parses without the repair path', () => {
    const r = parseJsonish('{"a": "line\\nline", "n": 3, "l": [1,2]}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.repaired, false);
    assert.strictEqual(r.value.a, 'line\nline');
});

test('an escaped quote inside a sentence does not end the string early', () => {
    const raw = '{"q": "hij zei \\"nee\\" en liep weg\nvolgende regel"}';
    const r = parseJsonish(raw);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.q, 'hij zei "nee" en liep weg\nvolgende regel');
});

test('a backslash at the end of a string value is not mistaken for an escape', () => {
    const r = parseJsonish('{"p": "C:\\\\map\\\\", "q": 1}');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.value.p, 'C:\\map\\');
});

test('a comma that is NOT trailing survives', () => {
    assert.deepStrictEqual(parseJsonish('{"a": [1, 2], "b": 3}').value, { a: [1, 2], b: 3 });
});

test('a comma inside a string is never treated as structure', () => {
    const raw = '{"s": "een, twee,]\nen verder"}';
    assert.strictEqual(parseJsonish(raw).value.s, 'een, twee,]\nen verder');
});

// ── What it deliberately does NOT do ──────────────────────────────────────

test('a truncated object is NOT closed — the caller has to be able to tell', () => {
    const r = parseJsonish('{"markdown": "# Kop\n\nHalverwege afgeka');
    assert.strictEqual(r.ok, false, 'half a document must never look like a whole one');
});

test('prose is not coerced into an object', () => {
    assert.strictEqual(parseJsonish('Ik kan dit niet lezen.').ok, false);
});

test('empty input is a clean miss, not a throw', () => {
    assert.strictEqual(parseJsonish('').ok, false);
    assert.strictEqual(parseJsonish('   ').ok, false);
    assert.strictEqual(parseJsonish(null).ok, false);
    assert.strictEqual(parseJsonish(undefined).ok, false);
});

// ── The pieces ────────────────────────────────────────────────────────────

test('stripFence leaves an unfenced payload alone', () => {
    assert.strictEqual(stripFence('{"a":1}'), '{"a":1}');
});

test('stripFence removes a fence with or without a language tag', () => {
    assert.strictEqual(stripFence('```json\n{"a":1}\n```'), '{"a":1}');
    assert.strictEqual(stripFence('```\n{"a":1}\n```'), '{"a":1}');
});

test('escapeControlChars leaves structure outside strings alone', () => {
    assert.strictEqual(escapeControlChars('{\n  "a": 1\n}'), '{\n  "a": 1\n}');
});
