/**
 * Unit tests for utils/unicodeSanitizer.js — the Unicode smuggling sanitizer.
 *
 * Verifies that:
 *   1. Steganographic characters (Variation Selectors 1-15, VS Supplement,
 *      Tags block, zero-width padding) are stripped
 *   2. Legitimate emoji features (VS16, ZWJ) are preserved
 *   3. Normal text passes through unchanged
 *
 * All invisible characters are written as \u escapes on purpose — literals
 * would make the fixtures unreadable (and uneditable) in most editors.
 *
 * Run: node --test utils/unicodeSanitizer.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    sanitizeUnicode,
    sanitizeMessagesUnicode,
    containsSmugglingChars,
} = require('./unicodeSanitizer');

test('normal text passes through unchanged', () => {
    const result = sanitizeUnicode('Hello, world! How are you?');
    assert.equal(result.stripped, 0);
    assert.equal(result.detected, false);
    assert.equal(result.clean, 'Hello, world! How are you?');
});

test('legitimate emoji (VS16 + ZWJ) are preserved', () => {
    // Heart + VS16, woman technologist (ZWJ), rainbow flag (VS16 + ZWJ)
    const emoji = '❤\uFE0F \u{1F469}\u200D\u{1F4BB} \u{1F3F3}\uFE0F\u200D\u{1F308}';
    const result = sanitizeUnicode(emoji);
    assert.equal(result.clean, emoji);
    assert.equal(result.stripped, 0);
});

test('Variation Selectors 1-15 (U+FE00-U+FE0E) are stripped', () => {
    const text = 'A\uFE00B\uFE05C\uFE0ED';
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 3);
    assert.equal(result.clean, 'ABCD');
    assert.equal(result.detected, true);
});

test('VS16 (U+FE0F) is NOT stripped (emoji presentation selector)', () => {
    const text = '❤\uFE0F'; // heart + VS16
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 0);
    assert.equal(result.clean, text);
});

test('ZWJ (U+200D) is NOT stripped (composite emoji joiner)', () => {
    const text = '\u{1F469}\u200D\u{1F4BB}'; // woman technologist
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 0);
    assert.equal(result.clean, text);
});

test('zero-width chars (ZWSP, ZWNJ, WJ) are stripped', () => {
    const text = 'Hello\u200B\u200C\u2060World';
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 3);
    assert.equal(result.clean, 'HelloWorld');
});

test('Tags block (U+E0001-U+E007F) is stripped (ASCII smuggling)', () => {
    // U+E0041 (Tag Latin Capital Letter A) = surrogate pair \uDB40\uDC41
    const text = 'ok\uDB40\uDC41\uDB40\uDC42\uDB40\uDC43ok';
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 3);
    assert.equal(result.clean, 'okok');
    assert.equal(result.detected, true);
});

test('Variation Selectors Supplement (U+E0100-U+E01EF) is stripped', () => {
    // U+E0100 = surrogate pair \uDB40\uDD00
    const text = 'X\uDB40\uDD00\uDB40\uDD50Y';
    const result = sanitizeUnicode(text);
    assert.equal(result.stripped, 2);
    assert.equal(result.clean, 'XY');
});

test('BOM at position 0 is preserved, elsewhere stripped', () => {
    const bomStart = sanitizeUnicode('\uFEFFHello');
    assert.equal(bomStart.stripped, 0);

    const bomMiddle = sanitizeUnicode('He\uFEFFllo');
    assert.equal(bomMiddle.stripped, 1);
    assert.equal(bomMiddle.clean, 'Hello');
});

test('sanitizeMessagesUnicode sanitizes user messages only', () => {
    const messages = [
        { role: 'system', content: 'You are helpful \uFE00 assistant' }, // system not sanitized
        { role: 'user', content: 'Hello \uFE01\uFE02\uFE03 world' },
        { role: 'assistant', content: 'I can help!' },
        { role: 'user', content: 'Normal message' },
    ];
    const result = sanitizeMessagesUnicode(messages);
    assert.equal(result.smugglingDetected, true);
    assert.equal(result.totalStripped, 3);
    assert.ok(messages[0].content.includes('\uFE00'), 'system message must NOT be sanitized');
    assert.equal(messages[1].content, 'Hello  world');
    assert.equal(result.detectedIn.length, 1, 'only one message should be flagged');
    assert.equal(result.detectedIn[0], 1);
});

test('containsSmugglingChars detects payloads and ignores clean text', () => {
    assert.ok(containsSmugglingChars('test\uFE00'), 'detects VS1');
    assert.ok(containsSmugglingChars('test\u200B'), 'detects ZWSP');
    assert.ok(containsSmugglingChars('test\uDB40\uDC41'), 'detects Tags block');
    assert.ok(!containsSmugglingChars('Hello world! \u{1F44B}'), 'clean text is not flagged');
    assert.ok(!containsSmugglingChars('❤\uFE0F'), 'VS16 emoji is not flagged');
});

test('simulated emoji smuggling payload is stripped, emoji preserved', () => {
    // Simulate encoding "hi" as VS chars after a smiley emoji:
    // 'h' = ASCII 104 -> U+FE00 + (104 - 97) = U+FE07
    // 'i' = ASCII 105 -> U+FE00 + (105 - 97) = U+FE08
    const smuggled = '\u{1F600}\uFE07\uFE08';
    const result = sanitizeUnicode(smuggled);
    assert.equal(result.stripped, 2);
    assert.equal(result.clean, '\u{1F600}');
    assert.equal(result.detected, true);
});
