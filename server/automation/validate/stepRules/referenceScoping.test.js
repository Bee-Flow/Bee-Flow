'use strict';

/**
 * Reference scoping reads paths the way the runner reads them.
 *
 * The runner, the expression engine and the builder share ONE path grammar
 * (shared/expr/path.mjs). The validator used to read only the first two
 * identifier segments of a path and assume the rest was fine, so:
 *   - a path the runner cannot parse (`fields.Story Points`) validated clean
 *     and resolved to nothing at run time;
 *   - an `{kind:'expr'}` input that does not parse validated clean and
 *     evaluated to nothing;
 *   - `steps["s1"]` was reported as "ref must include a step id";
 *   - HTTP url/headers/body, approval texts and form pages were never
 *     scoped, so a deleted step there shipped blanks;
 *   - a `{{ … }}` with a `}` inside a quoted key was invisible.
 * And it must NOT start flagging what resolves fine: the grammar is wider than
 * it was (unicode, `-`, digits in dotted segments, match segments).
 *
 * Run: node --test automation/validate/stepRules/referenceScoping.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { validateDefinition } = require('../../validate');

const all = (v) => [...v.errors, ...v.warnings];
const codes = (v) => all(v).map(f => f.code);
const withCode = (v, code) => all(v).filter(f => f.code === code);

/** trg → s1 (an upstream with output) → the step under test. */
function def(step, { trigger = { id: 'trg', type: 'trigger', kind: 'manual' }, extra = [] } = {}) {
    const s1 = { id: 's1', type: 'set', fields: { a: { kind: 'literal', value: 1 } } };
    const steps = [s1, ...extra, step];
    const edges = [{ from: trigger.id, to: 's1' }];
    for (let i = 0; i < steps.length - 1; i++) edges.push({ from: steps[i].id, to: steps[i + 1].id });
    return { trigger, steps, edges };
}
const note = (fields) => ({ id: 'n', type: 'notification', title: 't', body: 'b', ...fields });

// ── Paths that resolve fine never warn ──────────────────────────────────

const VALID_PATHS = [
    'steps.s1.output.items.0.name',            // older AI-built spelling: key "0"
    'steps.s1.output.first-name',
    'steps.s1.output.1099_amount',
    'steps.s1.output.prénom',
    'steps.s1.output.items[-1].name',
    'steps.s1.output["a\\"b"]',
    'steps.s1.output.items[ 0 ].name',
    'steps.s1.output["content-type"]',
    'steps.s1.output.payload.headers[name="Subject"].value',   // match segment
    'steps.s1.output.list[id=5].v',
    'steps["s1"].output.value',
    "steps['s1'].output.value",
];

for (const path of VALID_PATHS) {
    test(`a path the runner resolves validates clean: ${path}`, () => {
        const asRef = validateDefinition(def(note({ inputs: { x: { kind: 'ref', path } } })));
        const asTpl = validateDefinition(def(note({ body: `Value: {{ ${path} }}` })));
        for (const v of [asRef, asTpl]) {
            const refFindings = all(v).filter(f => f.code.startsWith('ref.'));
            assert.deepStrictEqual(refFindings.map(f => `${f.code}: ${f.message}`), []);
        }
    });
}

test('a `}` inside a quoted key: the placeholder is seen, scoped and clean', () => {
    const ok = validateDefinition(def(note({ body: 'x {{steps.s1.output["a}b"]}} y' })));
    assert.deepStrictEqual(all(ok).filter(f => f.code.startsWith('ref.')), []);
    const typo = validateDefinition(def(note({ body: 'x {{steps.gone.output["a}b"]}} y' })));
    assert.strictEqual(withCode(typo, 'ref.unknown_step').length, 1, 'the step behind a `}` key is checked');
});

// ── Paths that do not parse warn, name the field, suggest the spelling ──

test('a ref path the runner cannot parse warns ref.syntax with the bracket spelling', () => {
    const v = validateDefinition(def(note({ inputs: { to: { kind: 'ref', path: 'steps.s1.output.fields.Story Points' } } })));
    assert.strictEqual(v.ok, true, 'a warning, never a blocked save');
    const [f] = withCode(v, 'ref.syntax');
    assert.ok(f, codes(v).join(', '));
    assert.strictEqual(f.severity, 'warning');
    assert.match(f.path, /inputs\.to$/, 'the finding points at the field');
    assert.match(f.message, /inputs\.to/);
    assert.match(f.hint, /steps\.s1\.output\.fields\["Story Points"\]/);
});

test('a template placeholder that does not parse warns too', () => {
    const v = validateDefinition(def(note({ body: 'Hi {{ steps.s1.output.items[abc].name }}' })));
    const [f] = withCode(v, 'ref.syntax');
    assert.ok(f, codes(v).join(', '));
    assert.match(f.message, /body/);
    assert.match(f.hint, /steps\.s1\.output\.items\.abc\.name/);
});

test('an unterminated bracket gets the closed spelling', () => {
    const v = validateDefinition(def(note({ inputs: { x: { kind: 'ref', path: 'steps.s1.output.items[0' } } })));
    const [f] = withCode(v, 'ref.syntax');
    assert.ok(f);
    assert.match(f.hint, /steps\.s1\.output\.items\[0\]/);
});

test('a broken path still has its step checked', () => {
    const v = validateDefinition(def(note({ inputs: { x: { kind: 'ref', path: 'steps.gone.output.Story Points' } } })));
    assert.ok(codes(v).includes('ref.syntax'));
    assert.ok(codes(v).includes('ref.unknown_step'), 'the head is still read: an unknown step is an error');
});

// ── Expression inputs are parsed ────────────────────────────────────────

test('an expr input that does not parse warns expr.parse, naming the field', () => {
    // {{ }} around a path inside an expression: the spelling without them is offered.
    const v = validateDefinition(def(note({ inputs: { total: { kind: 'expr', value: '{{trigger.output.total}} * 2' } } })));
    assert.strictEqual(v.ok, true);
    const [f] = withCode(v, 'expr.parse');
    assert.ok(f, codes(v).join(', '));
    assert.strictEqual(f.severity, 'warning');
    assert.match(f.path, /inputs\.total$/);
    assert.match(f.message, /inputs\.total/);
    assert.match(f.hint, /trigger\.output\.total \* 2/);
    // A key with a space: no confident spelling, the hint says how.
    const spaced = validateDefinition(def(note({ inputs: { sp: { kind: 'expr', value: 'trigger.output.fields.Story Points' } } })));
    const [g] = withCode(spaced, 'expr.parse');
    assert.ok(g, codes(spaced).join(', '));
    assert.match(g.hint, /\["…"\]/);
});

test('an expr input in a spelling the engine reads is clean', () => {
    // The engine reads dotted positions (`attachments.0`) like the path grammar.
    const v = validateDefinition(def(note({ inputs: { file: { kind: 'expr', value: 'trigger.output.attachments.0.filename' } } })));
    assert.deepStrictEqual(withCode(v, 'expr.parse'), []);
});

test('an expr input with a match segment parses', () => {
    const v = validateDefinition(def(note({ inputs: { s: { kind: 'expr', value: 'steps.s1.output.headers[name="Subject"].value' } } })));
    assert.deepStrictEqual(withCode(v, 'expr.parse'), []);
});

test('a set field expr is reported once, by its own rule', () => {
    const v = validateDefinition(def({ id: 'st', type: 'set', fields: { x: { kind: 'expr', value: 'a +' } } }));
    assert.ok(codes(v).includes('set.field_expr_parse'));
    assert.deepStrictEqual(withCode(v, 'expr.parse'), []);
});

test('an approval stage condition written as a template is caught and spelled out', () => {
    const step = {
        id: 'ap', type: 'approval', prompt: 'OK?',
        approval: { stages: [{ name: 'Finance', approvers: [{ userId: 'u1' }], when: '{{steps.s1.output.total}} > 5000' }] },
    };
    const v = validateDefinition(def(step));
    const [f] = withCode(v, 'expr.parse');
    assert.ok(f, codes(v).join(', '));
    assert.match(f.path, /approval\.stages\[0\]\.when$/);
    assert.match(f.hint, /steps\.s1\.output\.total > 5000/);
});

// ── The bracket head names its step ─────────────────────────────────────

test('steps["id"] is a step reference, known or not', () => {
    const good = validateDefinition(def(note({ inputs: { x: { kind: 'ref', path: 'steps["s1"].output.value' } } })));
    assert.ok(!codes(good).includes('ref.no_step_id'), codes(good).join(', '));
    const bad = validateDefinition(def(note({ inputs: { x: { kind: 'ref', path: 'steps["nope"].output.value' } } })));
    assert.ok(codes(bad).includes('ref.unknown_step'), codes(bad).join(', '));
    assert.ok(!codes(bad).includes('ref.no_step_id'));
});

test('a step id inside a match VALUE is a value, not a step reference', () => {
    const v = validateDefinition(def(note({ body: '{{steps.s1.output.list[id="nope"].v}}', inputs: { x: { kind: 'ref', path: 'steps.s1.output.list[step="gone"].v' } } })));
    assert.deepStrictEqual(all(v).filter(f => f.code.startsWith('ref.')).map(f => f.message), []);
});

test('the find_rows count notice also reads the bracket head', () => {
    const dt = { id: 'dt', type: 'datatable', op: 'find_rows', datatableId: 'tbl_1' };
    const v = validateDefinition(def(note({ inputs: { n: { kind: 'ref', path: 'steps["dt"].output.count' } } }), { extra: [dt] }));
    assert.ok(codes(v).includes('datatable.count_deprecated'), codes(v).join(', '));
});

// ── Surfaces the runner interpolates are scoped ─────────────────────────

test('http_request url, headers and body are scoped', () => {
    const v = validateDefinition(def({
        id: 'h', type: 'http_request', method: 'POST',
        url: 'https://erp.example/orders/{{steps.gone1.output.id}}',
        headers: { 'X-Order': '{{steps.gone2.output.name}}' },
        body: '{"x": "{{steps.gone3.output.x}}"}',
    }));
    const msgs = withCode(v, 'ref.unknown_step').map(f => f.message).join('\n');
    for (const id of ['gone1', 'gone2', 'gone3']) assert.match(msgs, new RegExp(`"${id}"`));
});

test('approval prompt, details, field texts, attachments and stages are scoped', () => {
    const v = validateDefinition(def({
        id: 'ap', type: 'approval', prompt: 'Approve {{steps.p.output.name}}?',
        approval: {
            details: '{{steps.d.output.lines}}',
            fields: [{ name: 'why', type: 'text', label: 'Why {{steps.l.output.id}}?' }],
            attachments: [{ binding: '{{steps.a.output.fileId}}' }],
            stages: [{ name: 'For {{steps.sn.output.x}}', approvers: [{ userId: 'u1' }], when: 'steps.w.output.total > 5' }],
        },
    }));
    const msgs = withCode(v, 'ref.unknown_step').map(f => f.message).join('\n');
    for (const id of ['p', 'd', 'l', 'a', 'sn', 'w']) assert.match(msgs, new RegExp(`step "${id}"`), `${id} missing in:\n${msgs}`);
});

test('a form page\'s texts are scoped', () => {
    const trigger = { id: 'trg', type: 'trigger', kind: 'form', form: { title: 'Start', fields: [{ name: 'name', type: 'text', label: 'Name' }] } };
    const v = validateDefinition(def({
        id: 'fp', type: 'form_page', mode: 'ending',
        form: { title: 'Thanks {{steps.gone.output.name}}', fields: [] },
    }, { trigger }));
    assert.ok(codes(v).includes('ref.unknown_step'), codes(v).join(', '));
});

test('a slide\'s chart labels and a list of stats are scoped', () => {
    const v = validateDefinition(def({
        id: 'sl', type: 'slide', title: 'T', chart: { type: 'bar', data: '{{steps.s1.output.rows}}', labels: '{{steps.gl.output.labels}}' },
        stats: ['{{steps.gs.output.total}}'],
    }));
    const msgs = withCode(v, 'ref.unknown_step').map(f => f.message).join('\n');
    assert.match(msgs, /"gl"/);
    assert.match(msgs, /"gs"/);
});

test('a step id inside an expression is scoped', () => {
    const cond = validateDefinition(def({ id: 'c', type: 'condition', expr: 'steps.gone.output.total > 5' }));
    assert.ok(codes(cond).includes('ref.unknown_step'), codes(cond).join(', '));
    const quoted = validateDefinition(def({ id: 'c', type: 'condition', expr: 'steps.s1.output.note == "steps.gone"' }));
    assert.ok(!codes(quoted).includes('ref.unknown_step'), 'text in quotes is not a reference');
    const input = validateDefinition(def(note({ inputs: { x: { kind: 'expr', value: 'steps["gone"].output.a + 1' } } })));
    assert.ok(codes(input).includes('ref.unknown_step'));
});

test('a literal with a quote-aware placeholder is still recognised as uninterpolated', () => {
    const v = validateDefinition(def(note({ inputs: { x: { kind: 'literal', value: 'id {{steps.s1.output["a}b"]}}' } } })));
    assert.ok(codes(v).includes('literal.uninterpolated'));
});

// ── parse_json's relative paths use the same grammar ────────────────────

test('parse_json accepts every relative path the runner resolves, refuses the rest', () => {
    const pj = (path) => validateDefinition(def({ id: 'pj', type: 'parse_json', sourceRef: 'steps.s1.output', fields: [{ name: 'f', path }] }));
    for (const ok of ['items.0.sku', '["content-type"]', 'payload.headers[name="Subject"].value', '[0].x', '$.a', 'items[-1]', 'prénom']) {
        assert.ok(!codes(pj(ok)).includes('parse_json.field_path_invalid'), `${ok} resolves at run time`);
    }
    for (const bad of ['a b', 'items[', 'a..b']) {
        assert.ok(codes(pj(bad)).includes('parse_json.field_path_invalid'), `${bad} does not`);
    }
});
