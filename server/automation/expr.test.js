/**
 * Unit tests for the restricted expression evaluator, focused on the
 * whitelisted helper functions (contains/startsWith/endsWith/lower/upper/
 * len/isEmpty) and the guarantee that no OTHER calls are evaluable.
 *
 * Run: node --test automation/expr.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const { evaluate, parseExpr, EXPR_FUNCTION_NAMES } = require('./expr');

const ctx = {
    item: { name: 'Report.docx', type: 'file', tags: ['a', 'b'], empty: '', count: 3, done: true },
    steps: { s1: { output: { items: [1, 2, 3], title: 'Re: hi', missing: null } } },
};

test('contains — string substring and array membership', () => {
    assert.strictEqual(evaluate('contains(item.name, ".docx")', ctx), true);
    assert.strictEqual(evaluate('contains(item.name, ".pdf")', ctx), false);
    assert.strictEqual(evaluate('contains(item.tags, "a")', ctx), true);
    assert.strictEqual(evaluate('contains(item.tags, "z")', ctx), false);
});

test('startsWith / endsWith', () => {
    assert.strictEqual(evaluate('startsWith(steps.s1.output.title, "Re:")', ctx), true);
    assert.strictEqual(evaluate('endsWith(item.name, ".docx")', ctx), true);
    assert.strictEqual(evaluate('endsWith(item.name, ".pdf")', ctx), false);
});

test('text matching ignores case (contains / startsWith / endsWith / includes)', () => {
    // The builder's "contains" operator is what a non-technical user reaches
    // for; requiring the exact casing made filters silently return nothing.
    assert.strictEqual(evaluate('contains(item.name, "REPORT")', ctx), true);
    assert.strictEqual(evaluate('contains(item.name, ".DOCX")', ctx), true);
    assert.strictEqual(evaluate('startsWith(steps.s1.output.title, "re:")', ctx), true);
    assert.strictEqual(evaluate('endsWith(item.name, ".DocX")', ctx), true);
    assert.strictEqual(evaluate('includes(item.tags, "A")', ctx), true);
    // Case-insensitivity must not make unrelated text match.
    assert.strictEqual(evaluate('contains(item.name, "invoice")', ctx), false);
    assert.strictEqual(evaluate('includes(item.tags, "z")', ctx), false);
});

test('lower / upper', () => {
    assert.strictEqual(evaluate('lower(item.type) == "file"', ctx), true);
    assert.strictEqual(evaluate('upper(item.type) == "FILE"', ctx), true);
});

test('len of arrays, strings, objects', () => {
    assert.strictEqual(evaluate('len(steps.s1.output.items)', ctx), 3);
    assert.strictEqual(evaluate('len(item.name)', ctx), 'Report.docx'.length);
    assert.strictEqual(evaluate('len(item) > 0', ctx), true);
});

test('isEmpty — null, empty string, empty/non-empty array', () => {
    assert.strictEqual(evaluate('isEmpty(item.empty)', ctx), true);
    assert.strictEqual(evaluate('isEmpty(item.tags)', ctx), false);
    assert.strictEqual(evaluate('isEmpty(steps.s1.output.missing)', ctx), true);
    assert.strictEqual(evaluate('!isEmpty(item.name)', ctx), true);
});

test('helpers are null-safe — never throw on missing paths', () => {
    assert.strictEqual(evaluate('contains(nope.gone, "x")', ctx), false);
    assert.strictEqual(evaluate('startsWith(nope.gone, "x")', ctx), false);
    assert.strictEqual(evaluate('isEmpty(nope.gone)', ctx), true);
    assert.strictEqual(evaluate('len(nope.gone)', ctx), 0);
});

test('helpers compose with comparators and logic', () => {
    assert.strictEqual(evaluate('item.type == "file" && len(item.tags) == 2', ctx), true);
    assert.strictEqual(evaluate('contains(item.name, "Report") || item.count > 100', ctx), true);
});

test('arbitrary function calls are rejected at parse time', () => {
    assert.throws(() => parseExpr('fetch(item.name)'), /Unknown function: fetch/);
    assert.throws(() => parseExpr('foo(1, 2)'), /Unknown function: foo/);
    // Member calls (`x.y()`) are not a thing — they leave trailing tokens.
    assert.throws(() => parseExpr('item.name.toLowerCase()'), /Trailing tokens/);
});

test('the [*] wildcard IS part of the grammar (flatten-map, walkPath semantics)', () => {
    // Contract change (user-reported): the variable picker inserts paths like
    // `steps.x.output.results[*].subject`, and the condition builder happily
    // serialised them into expressions — which then threw "Unexpected token: *"
    // at eval time, and the condition swallowed that into a silent `false` →
    // wrong branch on every run. The engine now resolves `[*]` exactly like
    // the binding resolver's walkPath: map the rest of the path over the
    // array, flatten one level, skip misses.
    assert.doesNotThrow(() => parseExpr('steps.s1.output.items[*].type'));

    const rich = {
        steps: {
            s1: {
                output: {
                    results: [
                        { subject: 'Re: Nextcloud ISV contract', tags: ['x'] },
                        { subject: 'Pitchdeck', tags: ['y', 'z'] },
                        null, // skipped, like walkPath
                        { noSubject: true },
                    ],
                },
            },
        },
    };
    // The exact user expression: any subject containing "ISV"?
    assert.strictEqual(evaluate('contains(steps.s1.output.results[*].subject, "ISV")', rich), true);
    assert.strictEqual(evaluate('contains(steps.s1.output.results[*].subject, "zeppelin")', rich), false);
    // Bare wildcard returns the (miss-skipping) elements.
    assert.strictEqual(evaluate('len(steps.s1.output.results[*].subject)', rich), 2);
    // Nested wildcards flatten one level per hop.
    assert.strictEqual(evaluate('len(steps.s1.output.results[*].tags[*])', rich), 3);
    // Wildcard on a non-array resolves undefined, helpers stay null-safe.
    assert.strictEqual(evaluate('contains(steps.s1.output.title[*], "x")', ctx), false);
    assert.strictEqual(evaluate('isEmpty(nope[*].x)', ctx), true);
});

test('whitelist is exported and stable', () => {
    assert.ok(Array.isArray(EXPR_FUNCTION_NAMES));
    for (const name of ['contains', 'startsWith', 'endsWith', 'lower', 'upper', 'len', 'isEmpty']) {
        assert.ok(EXPR_FUNCTION_NAMES.includes(name), `whitelist includes ${name}`);
    }
});

test('walkPath never walks the prototype chain, via dot OR bracket access', () => {
    // Dot access was already gated before this fix.
    assert.strictEqual(evaluate('item.constructor', ctx), undefined);
    assert.strictEqual(evaluate('item.name.constructor', ctx), undefined);
    // Bracket access was the actual gap: only the dot-access branch of
    // walkPath gated with hasOwnProperty, so ["constructor"]["constructor"]
    // could walk all the way to Function.
    assert.strictEqual(evaluate('item["constructor"]', ctx), undefined);
    assert.strictEqual(evaluate('steps.s1.output["constructor"]["constructor"]["name"]', ctx), undefined);
    // Legitimate own-property access must still resolve — the fix must not
    // be over-broad.
    assert.strictEqual(evaluate('len(steps.s1.output.items)', ctx), 3);
    assert.strictEqual(evaluate('steps.s1.output.items[0]', ctx), 1);
});
