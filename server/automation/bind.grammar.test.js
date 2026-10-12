/**
 * One path, one value — whatever kind of binding carries it.
 *
 * Before shared/expr/path.mjs a picked field could resolve in a `ref`, come
 * back empty in a `{{template}}`, throw inside an `expr` and mean something
 * else again in the parse_json step, depending only on how the editor
 * happened to save it. These cases pin the runtime half of that promise for
 * the payload shapes the audit found broken: keys with `]`, `}`, quotes,
 * backslashes or unicode in them, lists of lists, null holes, JSON that
 * arrived as text, the last element of a list.
 *
 * The golden differential at the bottom walks EVERY leaf of a deep fixture
 * by its canonical path (the one path.mjs formatKey writes, so the one the
 * builder saves) and demands the same value from ref, template, expr and
 * walkRelativePath.
 *
 * Run: node --test automation/bind.grammar.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveValue, interpolateTemplate, walkPath, walkRelativePath } = require('./bind');
const { appendKey, appendWildcard } = require('./expr');

const ODD = {
    'a}b': 'brace',
    'x]y': 'bracket',
    'say "hi"': 'quoted',
    "both\"'": 'both quotes',
    'back\\slash': 'backslash',
    'tab\there': 'tab',
    'new\nline': 'newline',
    'contact[email]': 'php form field',
    'items[0][sku]': 'php list field',
    'content-type': 'hyphen',
    '@odata.etag': 'odata',
    'Story Points': 5,
    'prénom': 'Zoë',
    '名前': 'Hanako',
    null: 'the key null',
    true: 'the key true',
};

const STATE = {
    trigger: { output: {} },
    steps: {
        x: {
            output: {
                odd: ODD,
                matrix: [[1, 2], [3, 4]],
                withNulls: [1, null, 2, undefined, 3],
                rows: [{ a: 1 }, null, { a: 3 }],
                body: '{"data":{"items":[{"id":7},{"id":8}]}}',
                fenced: '```json\n{"customer":{"name":"Acme"}}\n```',
                items: [{ id: 1 }, { id: 2 }, { id: 3 }],
                deep: {
                    a: { b: [{ c: { d: [{ e: { f: 'seven levels' } }] } }] },
                },
            },
        },
    },
    vars: {},
    loop: {},
    secrets: {},
};

const ref = (path) => resolveValue({ kind: 'ref', path }, STATE);
const expr = (value) => resolveValue({ kind: 'expr', value }, STATE);
const tpl = (value) => resolveValue({ kind: 'template', value }, STATE, { listAs: 'json' });
const P = 'steps.x.output';

test('every odd key is addressable by its canonical path in ref, expr and template', () => {
    for (const [key, want] of Object.entries(ODD)) {
        const path = appendKey(`${P}.odd`, key);
        assert.deepEqual(ref(path), want, `ref ${path}`);
        assert.deepEqual(expr(path), want, `expr ${path}`);
        assert.equal(tpl(`{{${path}}}`), String(want), `template ${path}`);
    }
});

test('a `}` or `]` inside a quoted key no longer ends the placeholder', () => {
    const s = { ...STATE, _templateWarnings: [] };
    assert.equal(interpolateTemplate(`k={{${P}.odd["a}b"]}}`, s), 'k=brace');
    assert.equal(interpolateTemplate(`k={{ ${P}.odd[ "x]y" ] }}`, s), 'k=bracket');
    assert.deepEqual(s._templateWarnings, []);
});

test('a trailing [*] keeps rows as rows; [*].field still flattens one level', () => {
    assert.deepEqual(ref(`${P}.matrix[*]`), [[1, 2], [3, 4]]);
    assert.deepEqual(expr(`${P}.matrix[*]`), [[1, 2], [3, 4]]);
    assert.deepEqual(ref(`${P}.deep.a.b[*].c.d[*].e.f`), ['seven levels']);
});

test('null elements are kept identically by a ref and inside a formula', () => {
    assert.deepEqual(ref(`${P}.withNulls[*]`), [1, null, 2, 3]);
    assert.deepEqual(expr(`${P}.withNulls[*]`), [1, null, 2, 3]);
    assert.deepEqual(ref(`${P}.rows[*]`), expr(`${P}.rows[*]`));
    assert.equal(expr(`count(${P}.withNulls[*])`), ref(`${P}.withNulls[*]`).length);
});

test('JSON text is read as the value it encodes, fenced or not', () => {
    assert.equal(ref(`${P}.body.data.items[0].id`), 7);
    assert.deepEqual(ref(`${P}.body.data.items[*].id`), [7, 8]);
    assert.equal(ref(`${P}.fenced.customer.name`), 'Acme');
    assert.equal(tpl(`{{${P}.body.data.items[-1].id}}`), '8');
    // `.length` of text stays the text's length.
    assert.equal(ref(`${P}.body.length`), STATE.steps.x.output.body.length);
});

test('older spellings keep working: items.0, [-1], unicode dotted names', () => {
    assert.equal(ref(`${P}.items.0.id`), 1);
    assert.equal(ref(`${P}.items[-1].id`), 3);
    assert.equal(ref(`${P}.odd.prénom`), 'Zoë');
    assert.equal(walkRelativePath('items.0.id', STATE.steps.x.output), 1);
    assert.equal(walkRelativePath('odd.prénom', STATE.steps.x.output), 'Zoë');
});

// ── Golden differential ──────────────────────────────────────────────────

/** Every leaf (and every list, through [*]) of a value with its canonical path. */
function leaves(value, prefix, out = []) {
    if (Array.isArray(value)) {
        value.forEach((el, i) => leaves(el, appendKey(prefix, i), out));
        if (value.length && value.every((el) => el && typeof el === 'object' && !Array.isArray(el))) {
            out.push(appendWildcard(prefix));
        }
        return out;
    }
    if (value && typeof value === 'object') {
        for (const k of Object.keys(value)) leaves(value[k], appendKey(prefix, k), out);
        return out;
    }
    out.push(prefix);
    return out;
}

test('golden differential: ref, expr, template and walkRelativePath agree on every leaf', () => {
    const output = STATE.steps.x.output;
    const paths = leaves(output, '');
    assert.ok(paths.length > 30, `fixture has ${paths.length} leaves`);
    for (const rel of paths) {
        const abs = rel.startsWith('[') ? `${P}${rel}` : `${P}.${rel}`;
        const want = walkRelativePath(rel, output);
        assert.deepEqual(walkPath(abs, STATE), want, `ref ${abs}`);
        assert.deepEqual(expr(abs), want, `expr ${abs}`);
        const text = tpl(`{{${abs}}}`);
        const wantText = want == null ? '' : (typeof want === 'object' ? JSON.stringify(want) : String(want));
        assert.equal(text, wantText, `template ${abs}`);
    }
});

test('a path that names a list reads JSON text that encodes one (walkList)', () => {
    const { walkList } = require('./bind');
    const root = { steps: { http: { output: { body: '[{"id":1},{"id":2}]', note: 'plain text' } } } };
    assert.deepStrictEqual(walkList('steps.http.output.body', root), [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(walkList('steps.http.output.note', root), 'plain text', 'text that is not a list stays text');
    assert.strictEqual(walkList('steps.http.output.missing', root), undefined);
});
