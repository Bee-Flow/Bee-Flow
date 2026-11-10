/**
 * regexMatch / regexReplace: behaviour, the `$` expansion, every parse-time
 * refusal, the text cap, and that the server runs RE2 (linear time).
 * Run: node --test server/shared/expr/regex.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluate, parseExpr } from './engine.mjs';
import { regexProblem, expandReplacement, compiledRegex, MAX_REGEX_PATTERN_CHARS, hasNestedQuantifier, hasRepeatedAlternation } from './regex.mjs';
import { REGEX_ENGINE, createRegex } from './regexEngine.mjs';
import { setMaxTextChars, DEFAULT_MAX_TEXT_CHARS } from './limits.mjs';

const ev = (src, scope = {}) => evaluate(src, scope);
// A formula string literal. A regex pattern is read from its source text, so a
// `\` is written once (`\d`); only a quote inside is escaped.
const q = (s) => `"${s.replace(/["']/g, '\\$&')}"`;

test('regexMatch: true when the pattern occurs, flags i/m/s, nothing is false', () => {
    assert.equal(ev(`regexMatch("Order 2026-11", ${q('\\d{4}-\\d{2}')})`), true);
    assert.equal(ev('regexMatch("abc", "^b")'), false);
    assert.equal(ev('regexMatch("ABC", "^abc$", "i")'), true);
    assert.equal(ev('regexMatch(t, "^b$", "m")', { t: 'a\nb' }), true);
    assert.equal(ev('regexMatch(t, "a.b", "s")', { t: 'a\nb' }), true);
    assert.equal(ev('regexMatch(t, "a.b")', { t: 'a\nb' }), false);
    assert.equal(ev('regexMatch(missing, "a")'), false);
    assert.equal(ev('regexMatch(12345, "^[0-9]+$")'), true, 'a number is read as its text');
    assert.equal(ev('regexMatch("é", "^\\p{L}$")'), true, 'u is always on');
});

test('regexReplace: every match, with $&, $1..$99 and $$', () => {
    assert.equal(ev('regexReplace("a1b22c333", "[0-9]+", "#")'), 'a#b#c#');
    assert.equal(ev('regexReplace("2026-11-04", "([0-9]+)-([0-9]+)-([0-9]+)", "$3.$2.$1")'), '04.11.2026');
    assert.equal(ev('regexReplace("ab", "b", "[$&]")'), 'a[b]');
    assert.equal(ev('regexReplace("ab", "b", "$$")'), 'a$');
    assert.equal(ev('regexReplace("ab", "(a)(x)?", "<$2|$1|$3>")'), '<|a|$3>b', 'an unmatched group is empty, a missing group stays as written');
    assert.equal(ev('regexReplace("Hello", "L", "_", "i")'), 'He__o');
    assert.equal(ev('regexReplace("abc", "x*", "-")'), '-a-b-c-', 'an empty match between every character');
    assert.equal(ev('regexReplace(missing, "a", "b")'), '');
    assert.equal(ev('regexReplace("aa", "a", missing)'), '', 'no replacement is the empty text');
});

test('expandReplacement: two-digit groups when there are that many, else one digit', () => {
    const groups = Array.from({ length: 12 }, (_, i) => `g${i + 1}`);
    assert.equal(expandReplacement('$12|$1|$13', 'm', groups), 'g12|g1|g13', '$13 past 12 groups is $1 then "3"');
    assert.equal(expandReplacement('$10', 'm', ['a']), 'a0');
    assert.equal(expandReplacement('$0 $', 'm', ['a']), '$0 $');
});

test('every refusal is a parse error naming the problem', () => {
    const refused = [
        ['regexMatch(x, y)', /must be written as a text/],
        ['regexMatch(x, "a", y)', /flags must be written as a text/],
        ['regexMatch(x, "")', /empty/],
        [`regexMatch(x, ${q('a'.repeat(MAX_REGEX_PATTERN_CHARS + 1))})`, /longer than 500/],
        ['regexMatch(x, "a", "g")', /unknown flag "g"/],
        ['regexMatch(x, "a", "y")', /unknown flag/],
        ['regexMatch(x, "(?=a)b")', /look-ahead/],
        ['regexMatch(x, "(?!a)b")', /look-ahead/],
        ['regexMatch(x, "(?<=a)b")', /look-ahead and look-behind/],
        ['regexMatch(x, "(?<!a)b")', /look-ahead and look-behind/],
        [`regexMatch(x, ${q('(a)\\1')})`, /back-references/],
        [`regexMatch(x, ${q('(?<n>a)\\k<n>')})`, /back-references/],
        ['regexMatch(x, "(a+)+")', /repeated group/],
        ['regexMatch(x, "(a*)*b")', /repeated group/],
        ['regexMatch(x, "(a|a)+$")', /may not hold an alternative/],
        ['regexMatch(x, "(a|aa)+$")', /may not hold an alternative/],
        [`regexMatch(x, ${q('(\\w|\\d)+x')})`, /may not hold an alternative/],
        ['regexMatch(x, "((a|b)c){2,}")', /may not hold an alternative/],
        ['regexMatch(x, "(x(a|b))*")', /may not hold an alternative/],
        ['regexMatch(x, "[")', /not a valid regular expression/],
        ['regexMatch(x, "a{2,1}")', /not a valid/],
        ['regexReplace(x, "a", "b", "i", 1)', /at most 4 arguments/],
        ['regexMatch(x, "a", "i", 1)', /at most 3 arguments/],
    ];
    for (const [src, re] of refused) assert.throws(() => parseExpr(src), re, src);
});

test('what the checks leave alone: character classes, escaped brackets, groups without nesting', () => {
    for (const p of ['[(?=]', '\\(?=x\\)', '(ab)+', '(a|b)c*', '(a|b)?', 'ab|c+', '[a|b]+', '(a\\|b)+', '[a-z]+@[a-z]+', '(?:x)y', '(?<name>x)']) {
        assert.equal(regexProblem(p, ''), null, p);
    }
    assert.equal(hasNestedQuantifier('(a+)+'), true);
    assert.equal(hasNestedQuantifier('[(a+)+]'), false);
    assert.equal(hasNestedQuantifier('(a|aa)+'), false, 'the file_intake scanner keeps its verdicts');
    assert.equal(hasRepeatedAlternation('(a|aa)+'), true);
    assert.equal(hasRepeatedAlternation('[(a|aa)+]'), false);
});

test('compiledRegex re-checks and caches', () => {
    assert.throws(() => compiledRegex('(a+)+', ''), /repeated group/);
    assert.strictEqual(compiledRegex('ab', 'i'), compiledRegex('ab', 'i'));
    assert.strictEqual(compiledRegex('ab', 'i'), compiledRegex('ab', 'ii'), 'flags are normalised');
});

test('the input text is bounded by EXPR_MAX_TEXT_CHARS, and so is the result', () => {
    try {
        setMaxTextChars(10);
        assert.throws(() => ev('regexMatch(t, "a")', { t: 'a'.repeat(11) }), (e) => e.code === 'expr_limit');
        assert.throws(() => ev('regexReplace(t, "a", "aaaa")', { t: 'aaaa' }), (e) => e.code === 'expr_limit');
        assert.equal(ev('regexReplace(t, "a", "bb")', { t: 'aaaaa' }), 'bbbbbbbbbb');
    } finally {
        setMaxTextChars(DEFAULT_MAX_TEXT_CHARS);
    }
});

test('the server runs RE2: a backtracking-prone pattern on a long input answers fast', () => {
    assert.equal(REGEX_ENGINE, 're2');
    const long = `${'x'.repeat(200_000)}`;
    const started = Date.now();
    assert.equal(ev('regexMatch(t, ".*x.*y.*z")', { t: long }), false);
    // Refused at parse time (repeated alternative); RE2 itself is linear on it.
    assert.equal(createRegex('(x|x)*y', 'u').test(long.slice(0, 5000)), false);
    assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
});

test('a backslash in a regex pattern literal is a regex escape (\\d, \\s, \\b); other strings keep their escapes', () => {
    assert.equal(ev('regexMatch("a1", "^a\\d$")'), true);
    assert.equal(ev('regexMatch("ad", "^a\\d$")'), false, '\\d is a digit, not the letter d');
    assert.equal(ev('regexReplace("a  b", "\\s+", "-")'), 'a-b');
    assert.equal(ev('regexMatch("ab", "a\\bb")'), false, '\\b is a word boundary, never a backspace');
    assert.equal(ev('regexMatch("say \\"hi\\"", "\\"hi\\"")'), true, 'an escaped quote stays a quote');
    assert.equal(ev('"a\\tb"'), 'a\tb', 'a normal string still unescapes');
});
