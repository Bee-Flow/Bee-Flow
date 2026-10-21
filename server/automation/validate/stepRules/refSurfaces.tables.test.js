'use strict';
/** Reference surfaces of the table steps: what is scoped, and the per-row roots that are not run data. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectStepRefs } = require('./refSurfaces');
const { validateDefinition } = require('../../validate');

test('read_table: the source is a reference surface', () => {
    const refs = collectStepRefs({ id: 'r', type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' } });
    assert.deepEqual(refs, [{ kind: 'ref', path: 'trigger.output.upload', where: 'source' }]);
});

test('table: source, join, filter rules and rulesFrom, derive values and a filter formula are collected', () => {
    const refs = collectStepRefs({
        id: 't', type: 'table',
        source: { kind: 'ref', path: 'steps.rd.output.table' },
        ops: [
            { op: 'join', with: { kind: 'ref', path: 'steps.other.output.table' } },
            { op: 'filter', rules: [{ column: 'A', test: 'in', value: { kind: 'ref', path: 'steps.lookup.output.values' } }], rulesFrom: { kind: 'ref', path: 'loop.seg.rules' }, expr: 'steps.cfg.output.min < row.A' },
            { op: 'derive', columns: [{ name: 'L', value: { kind: 'template', value: '{{steps.cfg.output.prefix}}-{{row.Name}}' } }, { name: 'E', value: { kind: 'expr', value: 'row.A + 1' } }] },
        ],
    });
    const paths = refs.filter(r => r.kind === 'ref').map(r => [r.where, r.path]);
    assert.deepEqual(paths, [
        ['source', 'steps.rd.output.table'],
        ['ops[0].with', 'steps.other.output.table'],
        ['ops[1].rulesFrom', 'loop.seg.rules'],
        ['ops[1].rules[0].value', 'steps.lookup.output.values'],
        ['ops[2].columns[0].value', 'steps.cfg.output.prefix'],
    ]);
    assert.deepEqual(refs.filter(r => r.kind === 'expr').map(r => [r.where, r.src, !!r.binding, r.parse]), [
        ['ops[1].expr', 'steps.cfg.output.min < row.A', false, true],
        ['ops[2].columns[1].value', 'row.A + 1', true, undefined],
    ]);
});

test('table: a path that starts with row or rowIndex is not a run reference', () => {
    const refs = collectStepRefs({
        id: 't', type: 'table', source: { kind: 'ref', path: 'steps.rd.output.table' },
        ops: [{ op: 'derive', columns: [
            { name: 'A', value: { kind: 'ref', path: 'row.Name' } },
            { name: 'B', value: { kind: 'template', value: '{{rowIndex}}: {{row.Name}}' } },
        ] }],
    });
    assert.deepEqual(refs.map(r => r.path), ['steps.rd.output.table']);
});

function defWith(table) {
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', output: {}, form: { title: 'T', fields: [{ name: 'upload', type: 'file', label: 'F' }] } },
        steps: [
            { id: 'rd', type: 'read_table', label: 'Read table', source: { kind: 'ref', path: 'trigger.output.upload' } },
            { id: 'tb', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.rd.output.table' }, ...table },
        ],
        edges: [{ from: 'trg', to: 'rd' }, { from: 'rd', to: 'tb' }],
    };
}

test('validator: row paths and a row expression are clean; a template step reference is still scoped', () => {
    const clean = validateDefinition(defWith({ ops: [
        { op: 'derive', columns: [
            { name: 'A', value: { kind: 'template', value: '{{row.Name}} #{{rowIndex}}' } },
            { name: 'B', value: { kind: 'expr', value: 'row.Score * 2' } },
        ] },
        { op: 'filter', rules: [], expr: 'row.Score > 1' },
    ] }));
    const relevant = (v) => [...v.errors, ...v.warnings].filter(f => /^ref\.|^expr\./.test(f.code));
    assert.deepEqual(relevant(clean), [], JSON.stringify(relevant(clean)));

    const bad = validateDefinition(defWith({ ops: [
        { op: 'derive', columns: [{ name: 'A', value: { kind: 'template', value: '{{steps.missing.output.x}} {{row.Name}}' } }] },
    ] }));
    const unknown = bad.errors.find(f => f.code === 'ref.unknown_step');
    assert.ok(unknown, JSON.stringify(bad.errors));
    assert.match(unknown.message, /missing/);
});

test('validator: a filter formula that does not parse is reported', () => {
    const v = validateDefinition(defWith({ ops: [{ op: 'filter', rules: [], expr: 'row.A >' }] }));
    assert.ok([...v.errors, ...v.warnings].some(f => f.code === 'expr.parse'), JSON.stringify([...v.errors, ...v.warnings]));
});
