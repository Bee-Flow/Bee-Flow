/**
 * mappingRules: the save-time checks on pick and compose bindings, a step's
 * `repeat` and a loop's `over`. Legacy bindings are referenceScoping's and
 * must validate exactly as before (the last test).
 *
 * Run: cd server && node --test automation/validate/stepRules/mappingRules.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDefinition } = require('../../validate');

const TRIGGER = { id: 'trg', kind: 'manual' };
function def(steps) {
    const ids = steps.map(s => s.id);
    return { trigger: TRIGGER, steps, edges: [{ from: 'trg', to: ids[0] }, ...ids.slice(1).map((id, i) => ({ from: ids[i], to: id }))] };
}
const set = (id, fields, extra = {}) => ({ id, type: 'set', fields, ...extra });
const pick = (from, take = 'one', as = 'native', extra = {}) => ({ kind: 'pick', v: 1, from, take, as, ...extra });
const S = (id, ...path) => ({ root: 'steps', id, path });
const SRC = set('src', { rows: { kind: 'literal', value: [{ email: 'a@b.nl' }] } });
const codes = (list, prefix) => list.filter(x => x.code.startsWith(prefix)).map(x => x.code);

test('a valid pick and compose validate clean', () => {
    const r = validateDefinition(def([
        SRC,
        set('use', { a: pick(S('src', 'rows', 'email'), 'all', 'list'), b: { kind: 'compose', v: 1, parts: ['x ', { from: S('src', 'rows'), take: 'count', as: 'text' }] } }),
        { id: 'n', type: 'notification', title: 'T', body: { kind: 'compose', v: 1, parts: ['Hoi ', { from: { root: 'trigger', path: ['naam'] }, take: 'one', as: 'text' }] }, channels: ['notification'] },
    ]));
    assert.deepStrictEqual(r.errors, []);
    assert.deepStrictEqual(codes(r.warnings, 'mapping.'), []);
});

test('a v1 pick that does not validate is an error; one without v is a literal (a warning)', () => {
    const r = validateDefinition(def([SRC, set('use', {
        bad: pick(S('src', 'rows'), 'twice'),
        unversioned: { kind: 'pick', from: S('src', 'rows'), take: 'one', as: 'native' },
    })]));
    assert.deepStrictEqual(codes(r.errors, 'mapping.'), ['mapping.invalid']);
    assert.match(r.errors.find(e => e.code === 'mapping.invalid').message, /pick_take/);
    assert.deepStrictEqual(codes(r.warnings, 'mapping.'), ['mapping.unversioned']);
});

test('upstream ordering: an unknown step is an error, a later one a warning', () => {
    const unknown = validateDefinition(def([SRC, set('use', { a: pick(S('nope', 'x')) })]));
    assert.deepStrictEqual(codes(unknown.errors, 'mapping.'), ['mapping.unknown_step']);
    const later = validateDefinition(def([set('use', { a: pick(S('src', 'rows'), 'one', 'native', { label: 'Rijen' }) }), SRC]));
    assert.deepStrictEqual(codes(later.warnings, 'mapping.'), ['mapping.forward']);
    assert.match(later.warnings.find(w => w.code === 'mapping.forward').message, /"Rijen"/);
});

test('each: only under the step\'s repeat, and only of the list it repeats over', () => {
    const each = pick(S('src', 'rows', 'email'), 'each');
    const without = validateDefinition(def([SRC, set('use', { to: each })]));
    assert.deepStrictEqual(codes(without.errors, 'mapping.'), ['mapping.each_outside_repeat']);
    const right = validateDefinition(def([SRC, set('use', { to: each }, { repeat: { over: S('src', 'rows') } })]));
    assert.deepStrictEqual(codes(right.errors, 'mapping.').concat(codes(right.errors, 'repeat.')), []);
    const other = validateDefinition(def([SRC, set('use', { to: each }, { repeat: { over: S('src', 'other') } })]));
    assert.deepStrictEqual(codes(other.errors, 'mapping.'), ['mapping.each_outside_repeat']);
    const inCompose = validateDefinition(def([SRC, set('use', { t: { kind: 'compose', v: 1, parts: [{ from: S('src', 'rows', 'email'), take: 'each', as: 'text' }] } })]));
    assert.deepStrictEqual(codes(inCompose.errors, 'mapping.'), ['mapping.each_outside_repeat']);
});

test('repeat: its shape, its step type, not beside list mode, and a leftover forEach warns', () => {
    const bad = validateDefinition(def([SRC, set('use', {}, { repeat: { over: { root: 'steps', path: [] }, max: 5000 } })]));
    assert.deepStrictEqual(codes(bad.errors, 'repeat.'), ['repeat.over_invalid']);
    const max = validateDefinition(def([SRC, set('use', {}, { repeat: { over: S('src', 'rows'), max: 5000 } })]));
    assert.deepStrictEqual(codes(max.errors, 'repeat.'), ['repeat.max_range']);
    const type = validateDefinition(def([SRC, { id: 'w', type: 'stop_error', message: 'x', repeat: { over: S('src', 'rows') } }]));
    assert.deepStrictEqual(codes(type.errors, 'repeat.'), ['repeat.type_unsupported']);
    const listMode = validateDefinition(def([SRC, set('use', {}, { arrayRef: 'steps.src.output.rows', repeat: { over: S('src', 'rows') } })]));
    assert.ok(codes(listMode.errors, 'repeat.').includes('repeat.with_list_mode'));
    const both = validateDefinition(def([SRC, set('use', { a: { kind: 'ref', path: 'loop.r.email' } }, { repeat: { over: S('src', 'rows') }, forEach: { overRef: 'steps.src.output.rows', itemVar: 'r' } })]));
    assert.deepStrictEqual(codes(both.warnings, 'repeat.'), ['repeat.with_for_each']);
    const shape = validateDefinition(def([SRC, set('use', {}, { repeat: 'rows' })]));
    assert.deepStrictEqual(codes(shape.errors, 'repeat.'), ['repeat.shape']);
    const unknown = validateDefinition(def([SRC, set('use', {}, { repeat: { over: S('nope', 'rows') } })]));
    assert.deepStrictEqual(codes(unknown.errors, 'mapping.'), ['mapping.unknown_step']);
});

test('a compose where the executor reads only plain text is an error', () => {
    const r = validateDefinition(def([SRC, {
        id: 'h', type: 'http_request', method: 'GET', url: 'https://example.org',
        headers: { 'X-A': { kind: 'compose', v: 1, parts: ['x'] } },
    }]));
    assert.deepStrictEqual(codes(r.errors, 'mapping.'), ['mapping.compose_unsupported']);
});

test('text fields that take a compose save with one (prompt, url, message, content)', () => {
    const c = { kind: 'compose', v: 1, parts: ['Hoi ', { from: S('src', 'rows', 'email'), take: 'all', as: 'text' }] };
    const r = validateDefinition(def([
        SRC,
        { id: 'h', type: 'http_request', method: 'GET', url: c },
        { id: 'd', type: 'generate_document', content: c },
        { id: 'stop', type: 'stop_error', message: c },
    ]));
    for (const code of ['http_request.url_missing', 'generate_document.content_missing', 'stop_error.message_missing']) {
        assert.ok(!r.errors.some(e => e.code === code), code);
    }
});

test('a loop over a v2 Source: no overRef needed; the Source is checked', () => {
    const body = [set('b', { e: pick({ root: 'loop', id: 'row', path: ['email'] }) })];
    const ok = validateDefinition(def([SRC, { id: 'lp', type: 'loop', itemVar: 'row', maxIterations: 10, over: S('src', 'rows'), body }]));
    assert.ok(!ok.errors.some(e => e.code === 'loop.overRef_missing'), JSON.stringify(ok.errors));
    assert.deepStrictEqual(codes(ok.errors, 'mapping.'), []);
    const bad = validateDefinition(def([SRC, { id: 'lp', type: 'loop', itemVar: 'row', maxIterations: 10, over: { root: 'nowhere' }, body }]));
    assert.deepStrictEqual(codes(bad.errors, 'loop.over'), ['loop.over_invalid']);
    const unbound = validateDefinition(def([SRC, set('x', { e: pick({ root: 'loop', id: 'row', path: ['email'] }) })]));
    assert.deepStrictEqual(codes(unbound.errors, 'mapping.'), ['mapping.loop_unbound']);
});

test('an unknown field of a source whose fields are known warns, with the fix', () => {
    const r = validateDefinition(def([SRC, set('use', { a: pick(S('src', 'rowz')) })]));
    const w = r.warnings.find(x => x.code === 'mapping.unknown_field');
    assert.ok(w, JSON.stringify(r.warnings));
    assert.deepStrictEqual(w.fix, { from: 'steps.src.output.rowz', to: 'steps.src.output.rows' });
});

test('legacy bindings validate exactly as before: no mapping finding for them', () => {
    const r = validateDefinition(def([SRC, set('use', {
        a: { kind: 'ref', path: 'steps.src.output.rows[0].email' },
        b: { kind: 'template', value: '{{steps.src.output.rows}}' },
        c: { kind: 'literal', value: pick(S('nope', 'x'), 'twice') },
    })]));
    assert.deepStrictEqual(codes(r.errors, 'mapping.').concat(codes(r.warnings, 'mapping.')), []);
});
