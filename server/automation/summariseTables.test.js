'use strict';
/** The plain-language lines of read_table and table, in the summary and in the builder's step list. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { summariseDefinition } = require('./summarise');
const { describeTableStep, tableDetail } = require('./summariseTables');

test('describeTableStep: one plain sentence per table step, null for anything else', () => {
    assert.equal(
        describeTableStep({ type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' }, sheets: 'all' }, '1.'),
        '1. Read table from `trigger.output.upload`.',
    );
    assert.equal(
        describeTableStep({ type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' }, sheets: ['Data'], label: 'Open the export' }, '1.'),
        '1. Read table from `trigger.output.upload` (sheets: Data) — Open the export.',
    );
    assert.match(describeTableStep({ type: 'read_table' }, '1.'), /a file that is not picked yet/);
    assert.equal(
        describeTableStep({ type: 'table', source: { kind: 'ref', path: 'steps.r.output.table' }, ops: [{ op: 'group' }, { op: 'pivot' }, { op: 'sample', enabled: false }] }, '2.'),
        '2. Edit table: group, pivot on `steps.r.output.table`.',
    );
    assert.match(describeTableStep({ type: 'table', ops: [] }, '2.'), /no operations yet/);
    assert.equal(describeTableStep({ type: 'set' }, '1.'), null);
});

test('tableDetail: a compact line for the builder agent, empty for other types', () => {
    assert.equal(
        tableDetail({ type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' }, sheets: 'first', headerRow: 2 }),
        ' from `trigger.output.upload` sheets=first headerRow=2',
    );
    assert.equal(
        tableDetail({ type: 'table', source: { kind: 'ref', path: 'steps.r.output.table' }, ops: [{ op: 'filter' }, { op: 'select', enabled: false }] }),
        ' on `steps.r.output.table` ops=[filter, select (off)]',
    );
    assert.equal(tableDetail({ type: 'notification' }), '');
});

test('the definition summary reads the two steps without a "step (id)" fallback', () => {
    const { summary, hasSideEffects } = summariseDefinition({
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'a', type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' } },
            { id: 'b', type: 'table', source: { kind: 'ref', path: 'steps.a.output.table' }, ops: [{ op: 'filter' }] },
        ],
        edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
    });
    assert.match(summary, /Read table from `trigger\.output\.upload`/);
    assert.match(summary, /Edit table: filter on `steps\.a\.output\.table`/);
    assert.doesNotMatch(summary, /step \(a\)|step \(b\)/);
    assert.equal(hasSideEffects, false);
});
