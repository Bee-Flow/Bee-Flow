/**
 * The design-time binding checks: checkRefPath, validateBinding and their
 * helpers. Every fix they offer must resolve, with the runtime's own walker,
 * to the value the writer meant.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { walkPath } from './legacy.mjs';
import {
    checkRefPath, closestName, templatePaths, validateBinding, TRIGGER_RUN_KEYS, RUNTIME_ROOTS,
    sourceProblems, isPick, isCompose, pickProblems, composeProblems,
} from './validate.mjs';

const STATE = {
    trigger: { output: { subject: 'S', body: { 'content-type': 'text/plain' }, 'Order date': 'd' }, kind: 'manual' },
    steps: { s1: { output: { items: [{ name: 'A' }] } } },
};

test('a canonical path has no issues', () => {
    for (const p of ['steps.s1.output.items[0].name', 'trigger.output["Order date"]', 'trigger.kind', 'trigger.headers.x', 'vars.rate', 'loop.row.name', 'secrets.k']) {
        assert.deepStrictEqual(checkRefPath(p), [], p);
    }
});

test('path_syntax: the fix is the same path in the spelling the runtime reads', () => {
    const cases = [
        ['steps.s1.output.items.0.name', 'steps.s1.output.items[0].name'],
        ['trigger.output.body.content-type', 'trigger.output.body["content-type"]'],
        ['trigger.output.Order date', 'trigger.output["Order date"]'],
    ];
    for (const [p, fix] of cases) {
        assert.equal(walkPath(p, STATE), undefined, `fixture: ${p} is what the runtime cannot read`);
        assert.deepStrictEqual(checkRefPath(p), [{ code: 'path_syntax', path: p, fix }], p);
        assert.notEqual(walkPath(fix, STATE), undefined, `the fix ${fix} reads the value`);
    }
    assert.deepStrictEqual(checkRefPath('x + 1'), [{ code: 'path_syntax', path: 'x + 1', fix: null }]);
    assert.deepStrictEqual(checkRefPath('steps.s1.output.items[0'), [{ code: 'path_syntax', path: 'steps.s1.output.items[0', fix: null }]);
    assert.deepStrictEqual(checkRefPath('steps.s1.output.items.0.name', { syntax: false }), [], 'a parser-made path skips the syntax check');
});

test('trigger_without_output: the payload is under trigger.output', () => {
    assert.deepStrictEqual(checkRefPath('trigger.subject'), [{ code: 'trigger_without_output', path: 'trigger.subject', fix: 'trigger.output.subject' }]);
    assert.deepStrictEqual(checkRefPath('trigger.items.0.x'), [
        { code: 'path_syntax', path: 'trigger.items.0.x', fix: 'trigger.items[0].x' },
        { code: 'trigger_without_output', path: 'trigger.items.0.x', fix: 'trigger.output.items[0].x' },
    ], 'each fix includes the fixes before it');
    for (const key of TRIGGER_RUN_KEYS) assert.deepStrictEqual(checkRefPath(`trigger.${key}`), [], key);
});

test('trigger_without_output on a metadata key only when the payload declares it too', () => {
    const fieldsOf = (src) => (src.root === 'trigger' ? ['id', 'name', 'output'] : null);
    assert.deepStrictEqual(checkRefPath('trigger.id', { fieldsOf }), [
        { code: 'trigger_without_output', path: 'trigger.id', fix: 'trigger.output.id', metadata: 'id' },
    ]);
    assert.deepStrictEqual(checkRefPath('trigger.kind', { fieldsOf }), [], 'not declared: the metadata is the reading');
    assert.deepStrictEqual(checkRefPath('trigger.output', { fieldsOf }), [], 'output is never the payload\'s own field');
    assert.deepStrictEqual(checkRefPath('trigger.id'), [], 'without fieldsOf nothing is known');
    const state = { trigger: { id: 'trg', output: { id: 'sheet-1' } } };
    assert.equal(walkPath(checkRefPath('trigger.id', { fieldsOf })[0].fix, state), 'sheet-1');
});

test('unknown_field: only where fieldsOf knows the list', () => {
    const fieldsOf = (src) => (src.root === 'trigger' ? ['subject', 'from'] : src.root === 'steps' && src.id === 's1' ? ['items'] : null);
    assert.deepStrictEqual(checkRefPath('trigger.output.subjct', { fieldsOf }), [
        { code: 'unknown_field', path: 'trigger.output.subjct', field: 'subjct', known: ['subject', 'from'], fix: 'trigger.output.subject' },
    ]);
    assert.deepStrictEqual(checkRefPath('steps.s1.output.itms[0].name', { fieldsOf }).map(i => i.fix), ['steps.s1.output.items[0].name']);
    assert.deepStrictEqual(checkRefPath('steps.s1.output.zzz', { fieldsOf }).map(i => i.fix), [null]);
    assert.deepStrictEqual(checkRefPath('steps.s2.output.zzz', { fieldsOf }), [], 'not known: nothing to say');
    assert.deepStrictEqual(checkRefPath('trigger.output', { fieldsOf }), [], 'the whole payload');
    assert.deepStrictEqual(checkRefPath('steps.s1.output[0]', { fieldsOf }), [], 'an index is not a field name');
    // The trigger fix feeds the field check.
    assert.deepStrictEqual(checkRefPath('trigger.subjct', { fieldsOf }).map(i => [i.code, i.fix]), [
        ['trigger_without_output', 'trigger.output.subjct'],
        ['unknown_field', 'trigger.output.subject'],
    ]);
});

test('validateBinding covers refs, every template placeholder and the paths of an expr', () => {
    assert.deepStrictEqual(validateBinding({ kind: 'ref', path: 'trigger.subject' }).map(i => [i.kind, i.code]), [['ref', 'trigger_without_output']]);
    assert.deepStrictEqual(validateBinding({ kind: 'template', value: 'a {{trigger.subject}} b {{steps.s1.output.items.0}}' }).map(i => [i.kind, i.code]), [
        ['template', 'trigger_without_output'], ['template', 'path_syntax'],
    ]);
    const exprPaths = (src) => (src === 'upper(trigger.subject)' ? ['trigger.subject'] : []);
    assert.deepStrictEqual(validateBinding({ kind: 'expr', value: 'upper(trigger.subject)' }, { exprPaths }).map(i => [i.kind, i.code]), [['expr', 'trigger_without_output']]);
    assert.deepStrictEqual(validateBinding({ kind: 'expr', value: 'x' }), [], 'no parser, no expr paths');
    assert.deepStrictEqual(validateBinding({ kind: 'expr', value: 'x' }, { exprPaths: () => { throw new Error('no'); } }), []);
    assert.deepStrictEqual(validateBinding({ kind: 'literal', value: 'trigger.subject' }), []);
    assert.deepStrictEqual(validateBinding(null), []);
});

test('templatePaths reads placeholders the way interpolateTemplate does', () => {
    assert.deepStrictEqual(templatePaths('a {{ x.y }} b {{z}} {{}}'), ['x.y', 'z']);
    assert.deepStrictEqual(templatePaths(42), []);
});

test('closestName: case first, then a third of the length, never a tie', () => {
    assert.equal(closestName('Subject', ['subject', 'from']), 'subject');
    assert.equal(closestName('subjet', ['subject', 'from']), 'subject');
    assert.equal(closestName('y', ['x']), null);
    assert.equal(closestName('abcd', ['abce', 'abcf']), null);
    assert.equal(closestName('zzzzzz', ['subject']), null);
});

test('RUNTIME_ROOTS are the roots a run state has', () => {
    assert.deepStrictEqual([...RUNTIME_ROOTS].sort(), ['loop', 'secrets', 'steps', 'trigger', 'vars']);
});

// ── v2 structure ───────────────────────────────────────────────────────────

test('sourceProblems: the roots, ids and segments a v2 Source may have', () => {
    assert.deepStrictEqual(sourceProblems({ root: 'steps', id: 's', path: ['a', 0] }), []);
    assert.deepStrictEqual(sourceProblems({ root: 'run', path: ['firedAt'] }), []);
    assert.deepStrictEqual(sourceProblems({ root: 'item', path: [] }), []);
    assert.deepStrictEqual(sourceProblems(null), ['source_shape']);
    assert.deepStrictEqual(sourceProblems({ root: 'secrets', path: [] }), ['source_root']);
    assert.deepStrictEqual(sourceProblems({ root: 'steps', path: [] }), ['source_id']);
    assert.deepStrictEqual(sourceProblems({ root: 'trigger', id: 'x', path: [] }), ['source_id']);
    assert.deepStrictEqual(sourceProblems({ root: 'vars' }), ['source_path']);
    assert.deepStrictEqual(sourceProblems({ root: 'vars', path: [{ wild: true }] }), ['source_segment']);
    assert.deepStrictEqual(sourceProblems({ root: 'vars', path: [-1] }), ['source_segment']);
    assert.deepStrictEqual(sourceProblems({ root: 'run', path: ['output'] }), ['source_run_key']);
});

test('isPick / isCompose: only version 1 AND a valid structure', () => {
    const pick = { kind: 'pick', v: 1, from: { root: 'trigger', path: ['a'] }, take: 'one', as: 'native' };
    assert.ok(isPick(pick));
    assert.ok(!isPick({ ...pick, v: undefined }), 'a literal object that carries kind: pick stays a literal');
    assert.ok(!isPick({ ...pick, v: 2 }));
    assert.deepStrictEqual(pickProblems({ ...pick, take: 'x', as: 'y', join: 'z', label: 1, required: 'yes' }), ['pick_take', 'pick_as', 'pick_join', 'pick_label', 'pick_required']);
    const compose = { kind: 'compose', v: 1, parts: ['a', { from: { root: 'vars', path: [] }, take: 'one', as: 'text' }] };
    assert.ok(isCompose(compose));
    assert.ok(!isCompose({ ...compose, v: undefined }));
    assert.deepStrictEqual(composeProblems({ kind: 'compose', v: 1, parts: [{ from: null, take: 'one', as: 'text' }] }), ['part_source_shape']);
    assert.deepStrictEqual(composeProblems({ kind: 'compose', v: 1 }), ['compose_parts']);
});

test('validateBinding on a pick: structure, the current item, and unknown fields', () => {
    const over = { root: 'steps', id: 's1', path: ['rows'] };
    const each = { kind: 'pick', v: 1, from: { root: 'steps', id: 's1', path: ['rows', 'email'] }, take: 'each', as: 'native', label: 'E-mail' };
    assert.deepStrictEqual(validateBinding(each, { repeatOver: over }), []);
    assert.deepStrictEqual(validateBinding(each).map(i => [i.code, i.path, i.label, i.kind]), [['each_outside_repeat', 'steps.s1.output.rows.email', 'E-mail', 'pick']]);
    const fieldsOf = (source) => (source.root === 'steps' ? ['rows', 'total'] : null);
    const typo = { kind: 'pick', v: 1, from: { root: 'steps', id: 's1', path: ['rowz'] }, take: 'all', as: 'list' };
    assert.deepStrictEqual(validateBinding(typo, { fieldsOf }).map(i => [i.code, i.field, i.fix]), [['unknown_field', 'rowz', 'steps.s1.output.rows']]);
    assert.deepStrictEqual(validateBinding({ ...typo, take: 'never' }).map(i => [i.code, i.problems]), [['mapping_structure', ['pick_take']]]);
    const compose = { kind: 'compose', v: 1, parts: ['x', { from: { root: 'steps', id: 's1', path: ['rows', 'email'] }, take: 'each', as: 'text' }] };
    assert.deepStrictEqual(validateBinding(compose, { repeatOver: { root: 'steps', id: 's1', path: ['other'] } }).map(i => [i.code, i.kind]), [['each_outside_repeat', 'compose']]);
});
