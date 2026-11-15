/**
 * The JavaScript-to-expression translator (mapExpr.mts): the expressions from
 * the official Nextcloud Hub flows (research 01 §1.5), the refusals, and the
 * guarantee that nothing it emits fails the automation expression parser.
 *
 * Run: cd server && node --test automation/importers/windmill/mapExpr.test.js
 */
const test = require('node:test');
const assert = require('node:assert');

const { translateInput, translateRule, segText } = require('./mapExpr.mts');
const { parseExpr } = require('../../expr');

/** A scope like a Nextcloud-triggered flow: `results.<id>` is `steps.<id>.output`. */
const scope = {
    flowInput(segs) {
        if (segs[0]?.v === 'authentication') return { drop: 'identity' };
        if (segs[0]?.v === 'iter') return segs[1]?.v === 'value' ? { path: `loop.item${segText(segs.slice(2))}` } : { path: 'loop._index' };
        return { path: `trigger.output${segText(segs)}` };
    },
    result: (id, segs) => ({ path: `steps.${id}.output${segText(segs)}` }),
    resume: (name, segs) => (name === 'resume' && segs.length === 1 && segs[0].v === 'error' ? { dsl: 'steps.ap.output.approved == false' } : { unsupported: 'no' }),
};

const js = (expr) => translateInput({ type: 'javascript', expr }, scope);

test('a plain path is a ref', () => {
    assert.deepStrictEqual(js('flow_input.event.submission.formId'), { kind: 'binding', binding: { kind: 'ref', path: 'trigger.output.event.submission.formId' }, confidence: 'high' });
    assert.deepStrictEqual(js('results.columns[0]["Approval Link"]').binding, { kind: 'ref', path: 'steps.columns.output[0]["Approval Link"]' });
});

test('the connection inputs are dropped', () => {
    assert.strictEqual(js('flow_input.authentication.trigger').kind, 'drop');
});

test('filter / map with an arrow become filter / map with it', () => {
    assert.deepStrictEqual(js('results.submission.submission.answers.filter((e) => e.questionName === "files")').binding,
        { kind: 'expr', value: 'filter(steps.submission.output.submission.answers, it.questionName === "files")' });
    assert.deepStrictEqual(js('results.s.answers.filter(e => e.questionName === "files").map(e => e.fileId)').binding,
        { kind: 'expr', value: 'map(filter(steps.s.output.answers, it.questionName === "files"), it.fileId)' });
});

test('find on equality is find(list, key, value); ?. is dropped', () => {
    assert.deepStrictEqual(js('results.columns.find(c => c.title === "Approval Link")?.id').binding,
        { kind: 'expr', value: 'find(steps.columns.output, "title", "Approval Link").id' });
    assert.deepStrictEqual(js('results.list.find(c => c.size > 3)').binding,
        { kind: 'expr', value: 'filter(steps.list.output, it.size > 3)[0]' });
});

test('the split / length - 1 idiom is last(split())', () => {
    const r = js('`${results.folder_name}/${results.path.split("/")[results.path.split("/").length - 1]}`');
    assert.deepStrictEqual(r.binding, { kind: 'expr', value: '(toStr(steps.folder_name.output) + "/" + toStr(last(split(steps.path.output, "/"))))' });
});

test('a template of paths and text is a template binding', () => {
    assert.deepStrictEqual(js('`/Reports/${results.folder}/Form.xlsx`').binding, { kind: 'template', value: '/Reports/{{steps.folder.output}}/Form.xlsx' });
    assert.deepStrictEqual(js('" Event von " + results.form.values.Name').binding, { kind: 'template', value: ' Event von {{steps.form.output.values.Name}}' });
    assert.deepStrictEqual(js('(results.form.values["Day"] + "T" + results.form.values.End + ":00")').binding,
        { kind: 'template', value: '{{steps.form.output.values.Day}}T{{steps.form.output.values.End}}:00' });
});

test('the approval outcome ternary reads the approval step', () => {
    assert.deepStrictEqual(js('resume?.error ? 2 : 1').binding, { kind: 'expr', value: '(steps.ap.output.approved == false) ? 2 : 1' });
});

test('loop items read loop.<itemVar>', () => {
    assert.deepStrictEqual(js('flow_input.iter.value.fileId').binding, { kind: 'ref', path: 'loop.item.fileId' });
    assert.deepStrictEqual(js('[flow_input.iter.value.fileId]').binding, { kind: 'expr', value: '[loop.item.fileId]' });
});

test('what has no counterpart goes to the AI builder with the original text', () => {
    for (const expr of [
        'JSON.stringify(results.route)',
        'new Date()',
        'results.items.map(a => a.list.map(b => b.x))',
        'results.a.replace(/x/g, "y")',
        '({ pdf: { id: String(flow_input.event.node.id) } })',
        'unknownName.value',
        'x = 1',
        'a; b',
        'typeof results.a',
        'results.a[results.b]',
    ]) {
        const r = js(expr);
        assert.strictEqual(r.kind, 'ai', `${expr} → ${JSON.stringify(r)}`);
        assert.strictEqual(r.original, expr);
        assert.ok(r.reason);
    }
});

test('constructor and __proto__ never become an expression', () => {
    for (const expr of ['results.a.constructor', 'results.a.__proto__.b', 'results.a["constructor"]', 'results.a.prototype', 'results.list.map(e => e.constructor)']) {
        assert.strictEqual(js(expr).kind, 'ai', expr);
    }
});

test('a static value is a literal; $res: / $var: become a connection, never a value', () => {
    assert.deepStrictEqual(translateInput({ type: 'static', value: 7 }, scope), { kind: 'binding', binding: { kind: 'literal', value: 7 }, confidence: 'high' });
    assert.deepStrictEqual(translateInput({ type: 'static', value: '$res:f/team/nextcloud' }, scope), { kind: 'connection', refs: [{ kind: 'resource', path: 'f/team/nextcloud' }] });
    assert.deepStrictEqual(translateInput({ type: 'static', value: { db: '$var:f/team/key' } }, scope), { kind: 'connection', refs: [{ kind: 'variable', path: 'f/team/key' }] });
});

test('rules translate for branches and skip conditions', () => {
    assert.deepStrictEqual(translateRule('results.submission.answers.length === 0', scope), { kind: 'rule', expr: 'len(steps.submission.output.answers) === 0', confidence: 'high' });
    const n = translateRule("Number(results.s.answers.find(a => a.questionName === 'people')?.text) > 20", scope);
    assert.deepStrictEqual(n, { kind: 'rule', expr: 'number(find(steps.s.output.answers, "questionName", "people").text) > 20', confidence: 'medium' });
});

test('every emitted expression parses as an automation expression (no object literals)', () => {
    const exprs = [
        'results.a && results.b || !results.c', 'results.a ?? "none"', 'results.n * 2 + 1 - results.m % 3', 'Math.max(results.a, 3)',
        'Object.keys(results.o).length', 'results.s.trim().toLowerCase()', 'results.s.split(",").join(";")', 'results.l.some(x => x.ok)',
        'results.l.every(x => x.n >= 1)', 'results.a ** 2', 'results.s.replaceAll("a", "b")', '`${results.a}-${results.b.length}`',
    ];
    for (const e of exprs) {
        const r = js(e);
        assert.strictEqual(r.kind, 'binding', e);
        if (r.binding.kind === 'expr') assert.doesNotThrow(() => parseExpr(r.binding.value, { objects: false }), e);
    }
});
