'use strict';
/** read_table and table through the AI builder: batch authoring, refusal with a field path, patching. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyToolCall, emptyDefinition } = require('../../builderTools');
const { validateDefinition } = require('../../validate');
const { ADD_FOR_TYPE } = require('./index');

const formWithUpload = async () => {
    const wrap = { userId: 'u', def: emptyDefinition() };
    await applyToolCall('builder_propose_trigger', {
        kind: 'form', form: { title: 'Upload', fields: [{ name: 'upload', type: 'file', label: 'File' }] },
    }, wrap);
    return wrap;
};
const stepOf = (wrap, id) => wrap.def.steps.find(s => s.id === id);
const READ = { tempId: 'r', type: 'read_table', spec: { source: { kind: 'ref', path: 'trigger.output.upload' } } };

test('both steps have a builder, and the batch adds them with the default labels as literals', async () => {
    assert.equal(typeof ADD_FOR_TYPE.read_table, 'function');
    assert.equal(typeof ADD_FOR_TYPE.table, 'function');
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { tempId: 't', type: 'table', spec: { source: 'steps.$r.output.table', ops: [
            { op: 'filter', rules: [{ column: 'Score', test: 'gt', value: 2 }] },
            { op: 'group', by: ['Team'], aggregates: [{ fn: 'count', as: 'count' }] },
        ] } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const read = stepOf(wrap, r.idMap.r);
    const table = stepOf(wrap, r.idMap.t);
    assert.equal(read.label, 'Read table');
    assert.equal(table.label, 'Edit table');
    assert.deepEqual(read.source, { kind: 'ref', path: 'trigger.output.upload' });
    assert.equal(read.sheets, 'all');
    assert.equal(read.headerRow, 1);
    assert.deepEqual(table.source, { kind: 'ref', path: `steps.${r.idMap.r}.output.table` }, 'a bare path becomes a ref, $tempId resolved');
    assert.deepEqual(table.ops.map(o => [o.id, o.op]), [['op1', 'filter'], ['op2', 'group']]);
    assert.equal(table.expiresInDays, 7);
    assert.deepEqual(wrap.def.edges.map(e => [e.from, e.to]), [['trg', r.idMap.r], [r.idMap.r, r.idMap.t]]);
    const v = validateDefinition(wrap.def);
    assert.deepEqual(v.errors.map(e => e.code), [], JSON.stringify(v.errors));
});

test('a label the caller gives replaces the default', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [{ ...READ, spec: { ...READ.spec, label: 'Open the export' } }] }, wrap);
    assert.equal(stepOf(wrap, r.idMap.r).label, 'Open the export');
});

test('read_table refuses a bad setting and names the field path', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [{ ...READ, spec: { ...READ.spec, headerRow: 99, format: 'pdf' } }] }, wrap);
    assert.match(r.error, /headerRow: /);
    assert.match(r.error, /format: /);
    assert.match(r._fixHint || '', /headerRow, format/);
    assert.equal(wrap.def.steps.length, 0, 'nothing was added');
});

test('read_table needs a source, and a typed-in value is not a file', async () => {
    const wrap = await formWithUpload();
    const none = await applyToolCall('builder_add_steps', { steps: [{ type: 'read_table', spec: {} }] }, wrap);
    assert.match(none.error, /source is required/);
    const literal = await applyToolCall('builder_add_steps', { steps: [{ type: 'read_table', spec: { source: { kind: 'literal', value: 'data.xlsx' } } }] }, wrap);
    assert.match(literal.error, /source must be a reference/);
});

test('table refuses an unknown operation and a bad rule, naming ops[i] paths', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { type: 'table', spec: { source: 'steps.$r.output.table', ops: [{ op: 'filter', rules: [] }, { op: 'explode' }] } },
    ] }, wrap);
    assert.ok(r.error, 'refused');
    assert.match(r.error, /ops\[1\]\.op/);
});

test('a reference that does not exist in the draft is refused with the path', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { type: 'table', spec: { source: 'steps.$r.output.tabel', ops: [] } },
    ] }, wrap);
    assert.match(r.error, /source/);
    // A step id that does not exist is the validator's to report, at the operation's own path.
    const other = await formWithUpload();
    const joined = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { type: 'table', spec: { source: 'steps.$r.output.table', ops: [{ op: 'join', with: { kind: 'ref', path: 'steps.nope.output.table' }, on: [{ left: 'A', right: 'A' }] }] } },
    ] }, other);
    assert.ok(!joined.error, joined.error);
    const v = validateDefinition(other.def);
    const unknown = v.errors.find(e => e.code === 'ref.unknown_step');
    assert.ok(unknown, JSON.stringify(v.errors));
    assert.match(unknown.message, /nope/);
});

test('a derived value and a filter formula may read the row; the validator does not flag it', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { tempId: 't', type: 'table', spec: { source: 'steps.$r.output.table', ops: [
            { op: 'derive', columns: [
                { name: 'Label', value: { kind: 'template', value: '{{row.Name}} ({{rowIndex}})' } },
                { name: 'Double', value: { kind: 'expr', value: 'row.Score * 2' } },
            ] },
            { op: 'filter', rules: [], expr: 'row.Score > 1' },
        ] } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    const v = validateDefinition(wrap.def);
    assert.deepEqual([...v.errors, ...v.warnings].filter(f => /^ref\.|^expr\./.test(f.code)), [], JSON.stringify(v.warnings));
});

test('forEach is accepted on both steps', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        { tempId: 'set', type: 'set', spec: { fields: { files: { kind: 'literal', value: [{ kind: 'form_upload', fileId: 'f1' }] } } } },
        { tempId: 'r', type: 'read_table', spec: { source: { kind: 'ref', path: 'loop.f' }, forEach: { overRef: 'steps.$set.output.files', itemVar: 'f' } } },
    ] }, wrap);
    assert.ok(!r.error, r.error);
    assert.equal(stepOf(wrap, r.idMap.r).forEach.itemVar, 'f');
});

test('builder_update_step patches the settings, normalised like an added step, and replaces ops wholesale', async () => {
    const wrap = await formWithUpload();
    const r = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { tempId: 't', type: 'table', spec: { source: 'steps.$r.output.table', ops: [{ op: 'select', keep: ['A'] }] } },
    ] }, wrap);
    const [rid, tid] = [r.idMap.r, r.idMap.t];

    const p1 = await applyToolCall('builder_update_step', { stepId: rid, patch: { headerRow: 3, sheets: ['Data'], delimiter: 'tab', expiresInDays: 30 } }, wrap);
    assert.ok(!p1.error, p1.error);
    const read = stepOf(wrap, rid);
    assert.deepEqual([read.headerRow, read.sheets, read.delimiter, read.expiresInDays], [3, ['Data'], '\t', 30]);

    const bad = await applyToolCall('builder_update_step', { stepId: rid, patch: { headerRow: 0 } }, wrap);
    assert.match(bad.error, /headerRow/);
    assert.equal(stepOf(wrap, rid).headerRow, 3, 'a refused patch changes nothing');
    const cleared = await applyToolCall('builder_update_step', { stepId: rid, patch: { source: null } }, wrap);
    assert.match(cleared.error, /source is required/);

    const p2 = await applyToolCall('builder_update_step', { stepId: tid, patch: { ops: [{ op: 'sample', n: 5 }], name: 'Sample' } }, wrap);
    assert.ok(!p2.error, p2.error);
    const table = stepOf(wrap, tid);
    assert.deepEqual(table.ops.map(o => o.op), ['sample']);
    assert.equal(table.ops[0].mode, 'first', 'ops are stored normalised');
    assert.equal(table.name, 'Sample');

    const p3 = await applyToolCall('builder_update_step', { stepId: tid, patch: { ops: [{ op: 'explode' }] } }, wrap);
    assert.match(p3.error, /ops\[0\]\.op/);
    assert.deepEqual(stepOf(wrap, tid).ops.map(o => o.op), ['sample']);

    const p4 = await applyToolCall('builder_update_step', { stepId: tid, patch: { label: 'Sampled' } }, wrap);
    assert.ok(!p4.error, p4.error);
    const nope = await applyToolCall('builder_update_step', { stepId: tid, patch: { sheets: 'all' } }, wrap);
    assert.match(nope.error, /not patchable on a table step/);
});

test('the reference check knows the output keys of both steps and refuses a misspelt one with a suggestion', async () => {
    const wrap = await formWithUpload();
    const ok = await applyToolCall('builder_add_steps', { steps: [
        READ,
        { tempId: 't', type: 'table', spec: { source: 'steps.$r.output.tablesByName.Sheet1', ops: [] } },
        { tempId: 'n', type: 'notification', spec: { title: 'Done', body: '{{steps.$t.output.rowCount}} rows, {{steps.$t.output.markdown}}', channels: ['notification'] } },
    ] }, wrap);
    assert.ok(!ok.error, ok.error);
    const bad = await applyToolCall('builder_add_steps', { steps: [
        { type: 'notification', spec: { title: 'x', body: `{{steps.${ok.idMap.t}.output.rowtotal}}`, channels: ['notification'] } },
    ] }, wrap);
    assert.match(bad.error || '', /has no "rowtotal"[^]*rowCount/);
});
