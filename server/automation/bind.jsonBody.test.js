/**
 * A JSON request body stays JSON, whatever the mapped values contain.
 *
 * The http_request body used to be plain text templating: a mapped string
 * went in raw and null/missing went in as nothing. So the body
 * `{"text":"{{steps.ai.output.summary}}"}` (the exact shape the editor's
 * placeholder teaches) broke for every record whose text held a quote, a
 * newline or a backslash, and `{"v":{{…}}}` broke for every empty field — an
 * external API answering 400 for SOME records only.
 *
 * interpolateJsonBody first writes the body as before. When that is valid
 * JSON (or the body is not JSON at all) it is sent byte for byte. Only a
 * JSON body the plain templating broke is repaired, and only at the
 * placeholders whose old text does not fit where they stand:
 *   - inside a JSON string: the value's text, JSON-escaped;
 *   - the whole string ("{{x}}") and the value is a record or a list whose
 *     JSON text would break the string: the record or list itself;
 *   - a bare JSON value: the old raw text when it is a run of complete JSON
 *     values that keeps the body valid, else the value as JSON, `null` when
 *     there is nothing.
 *
 * Run: node --test automation/bind.jsonBody.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { interpolateJsonBody, interpolateTemplate } = require('./bind');

const state = () => ({
    trigger: { output: {} },
    steps: {
        ai: {
            output: {
                summary: 'He said "ship it"\nNext line\\path\ttab',
                customer: 'Acme "BV"',
                maybe: null,
                count: 3,
                flag: false,
                numText: '42',
                idText: '01234',
                record: { name: 'Ann', tags: ['a', 'b'] },
                list: ['a@x.nl', 'b@x.nl'],
                jsonText: '{"a":1,"b":[2,3]}',
                fenced: '```json\n{"a":1}\n```',
            },
        },
    },
    vars: {},
    loop: {},
    secrets: {},
    _templateWarnings: [],
});
const P = 'steps.ai.output';
const body = (tpl, opts) => interpolateJsonBody(tpl, state(), opts);
const parsed = (tpl, opts) => JSON.parse(body(tpl, opts));

test('a mapped string inside a JSON string is escaped, so the body stays valid', () => {
    assert.deepEqual(parsed(`{"text":"{{${P}.summary}}"}`), { text: 'He said "ship it"\nNext line\\path\ttab' });
    assert.deepEqual(parsed(`{"customer":"{{${P}.customer}}"}`), { customer: 'Acme "BV"' });
    assert.deepEqual(parsed(`{"line":"Dear {{${P}.customer}}, see below"}`), { line: 'Dear Acme "BV", see below' });
});

test('a bare placeholder becomes the value as JSON; nothing becomes null', () => {
    assert.deepEqual(parsed(`{"v":{{${P}.maybe}}}`), { v: null });
    assert.deepEqual(parsed(`{"v":{{${P}.nope}}}`), { v: null });
    assert.deepEqual(parsed(`{"n":{{${P}.count}},"f":{{${P}.flag}}}`), { n: 3, f: false });
    assert.deepEqual(parsed(`{"r":{{${P}.record}},"l":{{${P}.list}}}`), {
        r: { name: 'Ann', tags: ['a', 'b'] },
        l: ['a@x.nl', 'b@x.nl'],
    });
    assert.deepEqual(parsed(`{"text":{{${P}.summary}}}`), { text: 'He said "ship it"\nNext line\\path\ttab' });
});

test('a bare placeholder keeps what already worked: JSON text and number-like text go in as JSON', () => {
    assert.deepEqual(parsed(`{"data":{{${P}.jsonText}}}`), { data: { a: 1, b: [2, 3] } });
    assert.deepEqual(parsed(`{"data":{{${P}.fenced}}}`), { data: { a: 1 } });
    assert.deepEqual(parsed(`{"n":{{${P}.numText}}}`), { n: 42 });
    assert.deepEqual(parsed(`{"id":{{${P}.idText}}}`), { id: '01234' });
});

test('"{{x}}" holding a record or a list puts the record or list itself in the body', () => {
    assert.deepEqual(parsed(`{"to":"{{${P}.list}}"}`), { to: ['a@x.nl', 'b@x.nl'] });
    assert.deepEqual(parsed(`{"customer":"{{${P}.record}}"}`), { customer: { name: 'Ann', tags: ['a', 'b'] } });
    // Mixed with other text it stays text: the JSON of the list, escaped.
    assert.deepEqual(parsed(`{"to":"To: {{${P}.list}}"}`), { to: 'To: ["a@x.nl","b@x.nl"]' });
    // A number or a missing value in quotes stays a string.
    assert.deepEqual(parsed(`{"n":"{{${P}.count}}","m":"{{${P}.nope}}"}`), { n: '3', m: '' });
});

test('arrays, nesting and whitespace are understood', () => {
    assert.deepEqual(parsed(`[ {"a": "{{${P}.customer}}"}, {{${P}.count}} ]`), [{ a: 'Acme "BV"' }, 3]);
    assert.deepEqual(parsed(`{\n  "outer": { "inner": [ "{{${P}.summary}}" ] }\n}`), {
        outer: { inner: ['He said "ship it"\nNext line\\path\ttab'] },
    });
    // A quote-escaped literal around a placeholder does not confuse the scan.
    assert.deepEqual(parsed(`{"q":"say \\"{{${P}.count}}\\""}`), { q: 'say "3"' });
});

test('a body that is not JSON-shaped keeps the plain templating', () => {
    const s = state();
    const form = `name={{${P}.customer}}&n={{${P}.count}}`;
    assert.equal(interpolateJsonBody(form, s), interpolateTemplate(form, s, { listAs: 'json' }));
    const whole = `{{${P}.record}}`;
    assert.equal(interpolateJsonBody(whole, s), interpolateTemplate(whole, s, { listAs: 'json' }));
    const text = `Hello {{${P}.customer}}`;
    assert.equal(interpolateJsonBody(text, s), `Hello Acme "BV"`);
});

test('an explicit non-JSON content type keeps the plain templating', () => {
    const s = state();
    const tpl = `{"text":"{{${P}.customer}}"}`;
    assert.equal(interpolateJsonBody(tpl, s, { contentType: 'text/plain' }), '{"text":"Acme "BV""}');
    assert.deepEqual(JSON.parse(interpolateJsonBody(tpl, s, { contentType: 'application/json; charset=utf-8' })), { text: 'Acme "BV"' });
    assert.deepEqual(JSON.parse(interpolateJsonBody(tpl, s, { contentType: 'application/vnd.api+json' })), { text: 'Acme "BV"' });
});

test('a missing path is still recorded as a template warning', () => {
    const s = state();
    interpolateJsonBody(`{"v":{{${P}.nope}},"w":"{{${P}.gone}}"}`, s);
    assert.deepEqual(s._templateWarnings, [`${P}.nope`, `${P}.gone`]);
});

// ── A body that was valid JSON before is sent byte for byte as before ──────
//
// The JSON-aware filling is a REPAIR, for bodies the plain templating broke.
// A body it did not break went out as is, and saved automations depend on
// those exact bytes: an ID list joined into `[{{ids}}]`, a string field that
// carries encoded JSON, `"{{x}}"` holding a list an API expects as text, a
// 64-bit id that JSON.parse would round. Each case pins the old rendering
// (interpolateTemplate with listAs 'json') AND the literal bytes.

const asBefore = (s, tpl) => interpolateTemplate(tpl, s, { listAs: 'json' });
const pinned = (vals) => ({
    trigger: { output: {} },
    steps: { s: { output: vals } },
    vars: {},
    loop: {},
    secrets: {},
    _templateWarnings: [],
});

test('a body that already was valid JSON is sent exactly as the plain templating wrote it', () => {
    const s = pinned({
        ids: '101,102,103',
        encoded: '"{\\"a\\":1}"',
        encodedList: '"[1,2]"',
        tags: [],
        counts: [3, 4],
        meta: {},
        rows: [{}],
        objs: '{"a":1},{"a":2}',
        quoted: '"a","b"',
        big: '{"id": 1234567890123456789, "amount": 10.10}',
    });
    const cases = [
        ['{"ids": [{{steps.s.output.ids}}]}', '{"ids": [101,102,103]}'],
        ['{"v": [{{steps.s.output.ids}}, 7]}', '{"v": [101,102,103, 7]}'],
        ['{"metadata": {{steps.s.output.encoded}}}', '{"metadata": "{\\"a\\":1}"}'],
        ['{"metadata": {{steps.s.output.encodedList}}}', '{"metadata": "[1,2]"}'],
        ['{"text": "{{steps.s.output.tags}}"}', '{"text": "[]"}'],
        ['{"text": "{{steps.s.output.counts}}"}', '{"text": "[3,4]"}'],
        ['{"text": "{{steps.s.output.meta}}"}', '{"text": "{}"}'],
        ['{"text": "{{steps.s.output.rows}}"}', '{"text": "[{}]"}'],
        ['[{{steps.s.output.objs}}]', '[{"a":1},{"a":2}]'],
        ['[{{steps.s.output.quoted}}]', '["a","b"]'],
        ['{"data": {{steps.s.output.big}}}', '{"data": {"id": 1234567890123456789, "amount": 10.10}}'],
    ];
    for (const [tpl, bytes] of cases) {
        assert.equal(asBefore(s, tpl), bytes, `the plain templating of ${tpl}`);
        assert.equal(interpolateJsonBody(tpl, s), bytes, tpl);
        assert.equal(interpolateJsonBody(tpl, s, { contentType: 'application/json' }), bytes, `${tpl} (application/json)`);
    }
});

test('repairing a broken body changes only the placeholders that broke it', () => {
    const s = pinned({
        ids: '101,102,103',
        counts: [3, 4],
        encoded: '"{\\"a\\":1}"',
        big: '{"id": 1234567890123456789}',
        note: 'He said "hi"',
    });
    // The quote in `note` broke the body; every other slot keeps its old text.
    const tpl = '{"note": "{{steps.s.output.note}}", "ids": [{{steps.s.output.ids}}], "c": "{{steps.s.output.counts}}", '
        + '"m": {{steps.s.output.encoded}}, "d": {{steps.s.output.big}}}';
    assert.throws(() => JSON.parse(asBefore(s, tpl)), 'precondition: the plain templating broke this body');
    assert.equal(interpolateJsonBody(tpl, s),
        '{"note": "He said \\"hi\\"", "ids": [101,102,103], "c": "[3,4]", "m": "{\\"a\\":1}", "d": {"id": 1234567890123456789}}');
});

test('in a body being repaired, raw text that would add keys goes in as a string', () => {
    const s = pinned({ qty: '1, "role": "admin"', note: 'a "b"' });
    const tpl = '{"qty": {{steps.s.output.qty}}, "note": "{{steps.s.output.note}}"}';
    assert.deepEqual(JSON.parse(interpolateJsonBody(tpl, s)), { qty: '1, "role": "admin"', note: 'a "b"' });
});

test('every placeholder is resolved once, also when the body is repaired', () => {
    const s = pinned({ note: 'a "b"' });
    interpolateJsonBody('{"n": "{{steps.s.output.note}}", "v": {{steps.s.output.nope}}}', s);
    assert.deepEqual(s._templateWarnings, ['steps.s.output.nope']);
});
