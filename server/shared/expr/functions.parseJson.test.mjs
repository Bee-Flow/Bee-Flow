/**
 * parseJson() reads JSON the way models write it, and reads paths the way
 * every other binding does. Run from server/:
 *   node --test shared/expr/functions.parseJson.test.mjs
 *
 * Two gaps closed here, both of which gave silent empty values:
 *   - the TEXT: plain JSON.parse returned null for a ```json fenced answer or
 *     one with prose around it, and `undefined` for JSON encoded twice; it
 *     now uses the same lenient reader as the parse_json step
 *     (path.mjs extractJsonText) and unwraps one level of double encoding;
 *   - the PATH: it walked with its own copy of an old tokenizer (no escapes,
 *     first-`]` split, no `[-1]`), so `parseJson(x, '["x]y"]')` disagreed
 *     with the same path in a binding. It now uses getRelativePath, the
 *     shared walker; a dotted path the shared grammar cannot read
 *     ("fields.Story Points") still resolves, key by key, as it always did.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS } from './functions.mjs';
import { evaluate } from './engine.mjs';

const { parseJson } = FUNCTIONS;
const DATA = { customer: { name: 'Acme', contacts: [{ email: 'a@x' }, { email: 'b@x' }] }, 'x]y': 1, fields: { 'Story Points': 5 } };
const TEXT = JSON.stringify(DATA);

test('fenced, prose-wrapped and double-encoded text parse', () => {
    assert.equal(parseJson('```json\n' + TEXT + '\n```', 'customer.name'), 'Acme');
    assert.equal(parseJson(`Sure! Here is the JSON:\n${TEXT}\nAnything else?`, 'customer.name'), 'Acme');
    assert.equal(parseJson(JSON.stringify(TEXT), 'customer.name'), 'Acme');
    assert.deepEqual(parseJson(JSON.stringify(TEXT)), DATA);
});

test('invalid text is still null, scalars still parse, objects pass through', () => {
    assert.equal(parseJson('{oops'), null);
    assert.equal(parseJson('no json here'), null);
    assert.equal(parseJson('   '), null);
    assert.equal(parseJson('42'), 42);
    assert.equal(parseJson('"plain"'), 'plain');
    assert.equal(parseJson(DATA, 'customer.name'), 'Acme');
});

test('paths use the shared grammar: escapes, brackets with ] inside, [-1], [*]', () => {
    assert.equal(parseJson(TEXT, '["x]y"]'), 1);
    assert.equal(parseJson(TEXT, 'customer.contacts[-1].email'), 'b@x');
    assert.deepEqual(parseJson(TEXT, 'customer.contacts[*].email'), ['a@x', 'b@x']);
    assert.equal(parseJson(TEXT, 'fields["Story Points"]'), 5);
    assert.equal(parseJson(TEXT, '$.customer.name'), 'Acme');
    assert.equal(parseJson(TEXT, 'customer.constructor'), undefined);
});

test('JSONPath habits, match segments and a matrix read like everywhere else', () => {
    const text = JSON.stringify({ order: { id: 7, line_items: [{ sku: 'a' }, { sku: 'b' }] }, m: [[1, 2], [3, 4]], headers: [{ name: 'Subject', value: 'Hi' }], q: { 'say "hi"': 1 } });
    assert.equal(parseJson(text, '$.order.id'), 7);
    assert.deepEqual(parseJson(text, '$.order.line_items[*].sku'), ['a', 'b']);
    assert.equal(parseJson(text, '$["order"].id'), 7);
    assert.equal(parseJson(text, 'headers[name="Subject"].value'), 'Hi');
    assert.deepEqual(parseJson(text, 'm[*]'), [[1, 2], [3, 4]]);
    assert.equal(parseJson(text, 'q["say \\"hi\\""]'), 1);
});

test('a dotted path with spaces keeps working', () => {
    assert.equal(parseJson(TEXT, 'fields.Story Points'), 5);
});

test('inside an expression', () => {
    assert.equal(evaluate('parseJson(raw, "customer.contacts[0].email")', { raw: '```json\n' + TEXT + '\n```' }), 'a@x');
});

test('an error text or page with a stray {} or [429] is not JSON: null, as before', () => {
    for (const text of [
        'Rate limited [429], retry later',
        'Upstream error {} occurred',
        '<html><script>var cfg = {};</script><body>502 Bad Gateway</body></html>',
        '{"id":7,"customer":{"id":99}, "lines":[{"id":1',
    ]) {
        assert.equal(parseJson(text), null, text);
        assert.equal(parseJson(text, 'id'), null, text);
        assert.equal(evaluate('parseJson(raw) == null', { raw: text }), true, text);
    }
});

test('every spelling the old walker read still resolves (leading dot, odd keys after a bracket, empty segments)', () => {
    const text = JSON.stringify({
        data: {
            id: 7,
            items: [{ 'Story Points': 5, 'user:name': 'ann', 'a/b': 9 }],
        },
    });
    assert.equal(parseJson(text, '.data.id'), 7);
    assert.equal(parseJson(text, 'data.items[0].Story Points'), 5);
    assert.equal(parseJson(text, 'data.items[0].user:name'), 'ann');
    assert.equal(parseJson(text, 'data.items[0].a/b'), 9);
    assert.deepEqual(parseJson(text, 'data.items[*].Story Points'), [5]);
    assert.equal(parseJson(text, 'data..id'), 7);
    assert.equal(parseJson(text, 'data.id.'), 7);
    assert.equal(evaluate('parseJson(t, ".data.id")', { t: text }), 7);
    assert.equal(evaluate('parseJson(t, "data.items[0].Story Points")', { t: text }), 5);
    // The fallback walks with the shared walker: still no prototype chain,
    // and a bracket that never closes is a miss, not a throw.
    assert.equal(parseJson(text, '.data.constructor'), undefined);
    assert.equal(parseJson(text, '__proto__.x y'), undefined);
    assert.equal(parseJson(text, 'data.items[0'), undefined);
});
