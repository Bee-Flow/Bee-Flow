/**
 * Date & time list mode (BFSF-375).
 *
 * The step joins the platform's `arrayRef` convention: present (even empty) =
 * work through a list, absent = one date. The two things that must hold:
 *
 *   1. A blank source is COMPLETENESS, not a hard error — the inspector
 *      autosaves while the author is still picking one, and blocking there
 *      400s every save of the whole routine.
 *   2. `item.<column>` is a legal ref root in list mode. Without that, every
 *      binding the editor writes warns `ref.invalid` on save.
 *
 * Run: node --test automation/validate.datetimeList.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { validateDefinition, COMPLETENESS_CODES } = require('./validate');

const codesOf = (res) => (res.errors || []).concat(res.warnings || []).map(r => r.code);
const dtCodes = (res) => codesOf(res).filter(c => c.startsWith('datetime.'));

const TRIGGER = { id: 'trg', type: 'trigger', kind: 'manual' };
const SEARCH = { id: 'search', type: 'code', code: 'return { results: [] };' };

function definition(step) {
    const all = [SEARCH, step];
    return {
        trigger: TRIGGER,
        steps: all,
        edges: [{ from: 'trg', to: 'search' }, { from: 'search', to: step.id }],
    };
}

const listStep = (extra = {}) => ({
    id: 'dt1', type: 'datetime', op: 'extract', part: 'day',
    arrayRef: 'steps.search.output.results',
    input: 'item.updated',
    ...extra,
});

test('a complete list-mode step validates clean', () => {
    assert.deepEqual(dtCodes(validateDefinition(definition(listStep()))), []);
});

test('single mode is unaffected — no arrayRef key, no complaints', () => {
    const step = { id: 'dt1', type: 'datetime', op: 'parse', input: 'trigger.output.when' };
    assert.deepEqual(dtCodes(validateDefinition(definition(step))), []);
});

test('a blank source list reports arrayRef_missing', () => {
    const codes = dtCodes(validateDefinition(definition(listStep({ arrayRef: '' }))));
    assert.ok(codes.includes('datetime.arrayRef_missing'), codes.join(', '));
});

test('arrayRef_missing is completeness, so the inspector can autosave mid-edit', () => {
    assert.ok(COMPLETENESS_CODES.has('datetime.arrayRef_missing'));
});

test('a non-string arrayRef is a real error, not completeness', () => {
    const codes = dtCodes(validateDefinition(definition(listStep({ arrayRef: 42 }))));
    assert.ok(codes.includes('datetime.arrayRef_type'), codes.join(', '));
});

test('`item.<column>` is legal in list mode and warns nothing', () => {
    const all = codesOf(validateDefinition(definition(listStep({ input: 'item.updated' }))));
    assert.ok(!all.some(c => c.startsWith('ref.')), all.join(', '));
});

test('`item` outside list mode still warns — there is no row to read', () => {
    const step = { id: 'dt1', type: 'datetime', op: 'extract', part: 'day', input: 'item.updated' };
    const all = codesOf(validateDefinition(definition(step)));
    assert.ok(all.some(c => c.startsWith('ref.')), all.join(', '));
});

test('a blank column name is rejected — it would produce a nameless column', () => {
    const codes = dtCodes(validateDefinition(definition(listStep({ target: '   ' }))));
    assert.ok(codes.includes('datetime.target_invalid'), codes.join(', '));
});

test('a named column validates clean', () => {
    assert.deepEqual(dtCodes(validateDefinition(definition(listStep({ target: 'dagnummer' })))), []);
});

test('forEach and list mode cannot be combined — both iterate', () => {
    const codes = dtCodes(validateDefinition(definition(listStep({ forEach: { overRef: 'steps.search.output.results' } }))));
    assert.ok(codes.includes('datetime.foreach_conflict'), codes.join(', '));
});

test('the source list is ref-checked, so a renamed upstream step is caught', () => {
    const all = codesOf(validateDefinition(definition(listStep({ arrayRef: 'steps.gone.output.results' }))));
    assert.ok(all.some(c => c === 'ref.unknown_step' || c === 'ref.invalid'), all.join(', '));
});

// A whole column in `input` with no `arrayRef`: a step saved before the
// builder converted it, imported, or AI-written. The runner reads it as list
// mode now; the validator says so, and how to store it that way.

test('a `[*]` column without arrayRef warns, naming the list mode it runs as', () => {
    const step = { id: 'dt1', type: 'datetime', op: 'extract', part: 'day', input: 'steps.search.output.results[*].updated' };
    const res = validateDefinition(definition(step));
    const hit = (res.warnings || []).find(w => w.code === 'datetime.input_column');
    assert.ok(hit, codesOf(res).join(', '));
    assert.equal(hit.severity, 'warning');
    assert.match(hit.message, /once per row of steps\.search\.output\.results/);
    assert.match(hit.hint, /input "item\.updated"/);
    assert.ok(!(res.errors || []).some(e => e.code === 'datetime.input_column'), 'never blocks the save');
    assert.ok(!COMPLETENESS_CODES.has('datetime.input_column'), 'and never blocks activation — the runner handles it');
});

test('a list of lists without arrayRef warns that no date can be read', () => {
    const step = { id: 'dt1', type: 'datetime', op: 'extract', part: 'day', input: 'steps.search.output.a[*].b[*].c' };
    const hit = (validateDefinition(definition(step)).warnings || []).find(w => w.code === 'datetime.input_column');
    assert.ok(hit);
    assert.match(hit.message, /not one date or one column/);
});

test('list mode and plain single dates do not get the column warning', () => {
    assert.ok(!dtCodes(validateDefinition(definition(listStep()))).includes('datetime.input_column'));
    const single = { id: 'dt1', type: 'datetime', op: 'parse', input: 'trigger.output.when' };
    assert.ok(!dtCodes(validateDefinition(definition(single))).includes('datetime.input_column'));
    const now = { id: 'dt1', type: 'datetime', op: 'now', input: 'steps.search.output.results[*].updated' };
    assert.ok(!dtCodes(validateDefinition(definition(now))).includes('datetime.input_column'),
        '`now` reads no input date, so a stale column there changes nothing');
});
