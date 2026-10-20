'use strict';
/** The table steps' validator rules: spec findings mapped onto the step's path, and the salt placement rule. */

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkReadTable, checkTable, checkSaltPlacement, checkSaltDeclared } = require('./tableRules');
const { validateDefinition } = require('../../validate');

function sinks(graph) {
    const errors = [];
    const warnings = [];
    return { errors, warnings, ctx: { graph, pushE: (r) => errors.push(r), pushW: (r) => warnings.push(r) } };
}

test('read_table: spec findings keep their severity and get the step path in front', () => {
    const { ctx, errors, warnings } = sinks({});
    checkReadTable(ctx, { id: 'r1', type: 'read_table', headerRow: 0, source: { kind: 'literal', value: 'a.xlsx' } }, 'steps[2]');
    assert.deepEqual(errors.map(e => [e.code, e.path]), [['read_table.header_row_invalid', 'steps[2].headerRow']]);
    assert.deepEqual(warnings.map(w => [w.code, w.path]), [['read_table.source_literal', 'steps[2].source']]);
    assert.match(warnings[0].hint, /form file answer or to a generated file/);
});

test('read_table: a missing source is an error; a clean step reports nothing; other types are ignored', () => {
    const missing = sinks({});
    checkReadTable(missing.ctx, { id: 'r1', type: 'read_table' }, 'steps[0]');
    assert.deepEqual(missing.errors.map(e => e.code), ['read_table.source_missing']);
    const clean = sinks({});
    checkReadTable(clean.ctx, { id: 'r1', type: 'read_table', source: { kind: 'ref', path: 'trigger.output.upload' } }, 'steps[0]');
    checkReadTable(clean.ctx, { id: 'x', type: 'table' }, 'steps[1]');
    assert.deepEqual([...clean.errors, ...clean.warnings], []);
});

test('table: findings of the shared spec are mapped with the path of the step in front', () => {
    const { ctx, errors } = sinks({});
    checkTable(ctx, { id: 't1', type: 'table', ops: [{ op: 'filter', rules: [] }, { op: 'explode' }] }, 'steps[4]');
    assert.ok(errors.length >= 2, JSON.stringify(errors));
    const unknown = errors.find(e => e.code === 'table.op_unknown');
    assert.equal(unknown.path, 'steps[4].ops[1].op');
    assert.equal(unknown.severity, 'error');
    assert.ok(unknown.hint, 'the spec hint travels');
    const missing = errors.find(e => e.code === 'table.source_missing');
    assert.equal(missing.path, 'steps[4].source');
});

test('table: a warning of the spec goes to the warning sink; a step of another type is ignored', () => {
    const { ctx, errors, warnings } = sinks({});
    const ops = [
        { op: 'groups', splits: [{ column: 'A' }] },
        { op: 'filter', rules: [{ column: 'A', test: 'is_empty' }] },
    ];
    checkTable(ctx, { id: 't1', type: 'table', source: { kind: 'ref', path: 'steps.r.output.table' }, ops }, 'steps[0]');
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings.map(w => [w.code, w.path]), [['table.ops_after_groups', 'steps[0].ops[1]']]);
    const other = sinks({});
    checkTable(other.ctx, { id: 'x', type: 'set' }, 'steps[0]');
    assert.deepEqual([...other.errors, ...other.warnings], []);
});

test('salt in the definition: a pseudonymise whose saltVar is a key of the definition vars warns', () => {
    const { ctx, warnings } = sinks({ vars: { pseudo_salt: 'a-literal-value', other: 1 } });
    const step = { id: 't1', type: 'table', ops: [
        { op: 'filter' },
        { op: 'pseudonymise', saltVar: 'pseudo_salt', columns: ['A'] },
        { op: 'pseudonymise', saltVar: 'from_solution', columns: ['B'] },
        { op: 'pseudonymise', saltVar: 'other', enabled: false, columns: ['C'] },
    ] };
    checkSaltPlacement(ctx, step, 'steps[1]');
    assert.deepEqual(warnings.map(w => [w.code, w.path]), [['table.salt_in_definition', 'steps[1].ops[1].saltVar']]);
    assert.doesNotMatch(JSON.stringify(warnings), /a-literal-value/, 'the salt itself is never echoed');
    const none = sinks({});
    checkSaltPlacement(none.ctx, step, 'steps[1]');
    assert.deepEqual(none.warnings, []);
});

test('end to end: a saved definition with a read_table and a table is validated at the right paths', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', output: {}, form: { title: 'T', fields: [{ name: 'upload', type: 'file', label: 'F' }] } },
        steps: [
            { id: 'rd', type: 'read_table', label: 'Read table', source: { kind: 'ref', path: 'trigger.output.upload' }, expiresInDays: 400 },
            { id: 'tb', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.rd.output.table' }, ops: [{ op: 'explode' }] },
        ],
        edges: [{ from: 'trg', to: 'rd' }, { from: 'rd', to: 'tb' }],
        vars: {},
    };
    const { errors } = validateDefinition(def);
    const byCode = Object.fromEntries(errors.map(e => [e.code, e.path]));
    assert.match(byCode['read_table.expires_invalid'], /steps\[rd\]\.expiresInDays$/);
    assert.match(byCode['table.op_unknown'], /steps\[tb\]\.ops\[0\]\.op$/);
});

const saltStep = { id: 't1', type: 'table', ops: [{ op: 'pseudonymise', columns: ['rec_id'], saltVar: 'TABLE_SALT' }, { op: 'pseudonymise', columns: ['x'], saltVar: 'OFF_SALT', enabled: false }] };

test('a salt variable nobody declared is an error on the op, and never echoes a value', () => {
    const { ctx, errors } = sinks({});
    checkSaltDeclared({ ...ctx, knownVarNames: new Set(['OTHER']) }, saltStep, 'steps[1]');
    assert.deepEqual(errors.map(e => [e.code, e.path]), [['table.salt_var_missing', 'steps[1].ops[0].saltVar']]);
    assert.match(errors[0].message, /TABLE_SALT/);
});

test('a declared salt variable (Solution or the automation own), or no catalogue at all, reports nothing', () => {
    const declared = sinks({});
    checkSaltDeclared({ ...declared.ctx, knownVarNames: new Set(['TABLE_SALT']) }, saltStep, 'steps[1]');
    const own = sinks({ vars: { TABLE_SALT: 'x' } });
    checkSaltDeclared({ ...own.ctx, knownVarNames: new Set() }, saltStep, 'steps[1]');
    const unknown = sinks({});
    checkSaltDeclared(unknown.ctx, saltStep, 'steps[1]');
    checkSaltDeclared({ ...unknown.ctx, knownVarNames: null }, saltStep, 'steps[1]');
    assert.deepEqual([...declared.errors, ...own.errors, ...unknown.errors], []);
});

test('end to end: a missing salt variable blocks activation but only warns in a draft', () => {
    const def = {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', output: {}, form: { title: 'T', fields: [{ name: 'upload', type: 'file', label: 'F' }] } },
        steps: [
            { id: 'rd', type: 'read_table', label: 'Read table', source: { kind: 'ref', path: 'trigger.output.upload' } },
            { id: 'tb', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.rd.output.table' }, ops: [{ id: 'p1', op: 'pseudonymise', columns: ['rec_id'], saltVar: 'TABLE_SALT' }] },
        ],
        edges: [{ from: 'trg', to: 'rd' }, { from: 'rd', to: 'tb' }],
        vars: {},
    };
    const activate = validateDefinition(def, { knownVarNames: new Set() });
    assert.ok(activate.errors.some(e => e.code === 'table.salt_var_missing'), JSON.stringify(activate.errors));
    const draft = validateDefinition(def, { stage: 'draft', knownVarNames: new Set() });
    assert.ok(!draft.errors.some(e => e.code === 'table.salt_var_missing'));
    assert.ok(draft.warnings.some(w => w.code === 'table.salt_var_missing' && w.blockedAt === 'activate'));
    assert.ok(!validateDefinition(def, { knownVarNames: new Set(['TABLE_SALT']) }).errors.some(e => e.code === 'table.salt_var_missing'));
    assert.ok(!validateDefinition(def).errors.some(e => e.code === 'table.salt_var_missing'), 'no catalogue, no check');
});
