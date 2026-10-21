'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execTable } = require('./execTable');
const { runTableOps } = require('./tables/ops');
const { toMarkdown } = require('./tables/ops/markdown');
const { LIMITS, cols } = require('./tables/ops/testKit');

const HANDLE = { kind: 'table', tableId: 'rtb_' + 'a'.repeat(32), runId: 'run0', name: 'In', columns: cols('region', 'amount'), rowCount: 3, preview: [], expiresAt: null, provenance: { origin: 'sheet' } };
const ROWS = Array.from({ length: 30 }, (_, i) => ({ region: i % 3 ? 'north' : 'south', amount: i }));

/** Fakes for everything that touches storage. */
function makeDeps(over = {}) {
    const calls = { open: [], write: [], floor: [] };
    const deps = {
        tableLimits: () => ({ ...LIMITS, ...(over.limits || {}) }),
        isTableHandle: (v) => !!v && v.kind === 'table',
        dryRunHandle: ({ name, columns }) => ({ kind: 'table', tableId: 'dry-run', runId: null, name, columns, rowCount: 0, preview: [], expiresAt: null, provenance: null }),
        openTable: async (h, scope) => {
            calls.open.push({ h, scope });
            if (over.expired) return null;
            const rows = over.rows || ROWS;
            return { row: {}, columns: h.columns, rows: () => (async function* gen() { yield* rows; })() };
        },
        writeTable: async (args) => {
            calls.write.push(args);
            const rows = [];
            for await (const r of args.rows) rows.push(r);
            return { kind: 'table', tableId: 'rtb_' + 'b'.repeat(32), runId: args.ctx.runId, name: args.name, columns: args.columns, rowCount: rows.length, preview: rows.slice(0, 3), expiresAt: null, provenance: args.provenance };
        },
        minGroupFloorFor: async (orgId) => { calls.floor.push(orgId); return over.floor ?? 0; },
        isCancelRequested: async () => false,
        runTableOps, toMarkdown,
    };
    return { deps, calls };
}

const CTX = { runId: 'run1', rootRunId: 'run1', automationId: 'auto1', userId: 'user1', orgId: 'org1' };
const step = (ops, extra = {}) => ({ id: 's2', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.s1.output.table' }, ops, ...extra });
const state = (table = HANDLE) => ({ vars: {}, steps: { s1: { output: { table } } }, _templateWarnings: [] });

test('a live run writes the result as a table and inlines a small result with markdown', async () => {
    const { deps, calls } = makeDeps();
    const rs = state();
    const { output } = await execTable(step([{ op: 'group', by: ['region'], aggregates: [{ fn: 'sum', column: 'amount', as: 'total' }] }], { name: 'Totals', expiresInDays: 3 }), CTX, rs, 'live', deps);
    assert.equal(calls.write.length, 1);
    assert.equal(calls.write[0].stepId, 's2');
    assert.equal(calls.write[0].name, 'Totals');
    assert.equal(calls.write[0].ttlDays, 3);
    assert.deepEqual(calls.write[0].provenance, { origin: 'sheet' });
    assert.deepEqual(calls.open[0].scope, { runId: 'run1', rootRunId: 'run1', automationId: 'auto1', userId: 'user1' });
    assert.equal(output.table.name, 'Totals');
    assert.equal(output.rowCount, 2);
    assert.deepEqual(output.rows.map((r) => r.region), ['south', 'north']);
    assert.match(output.markdown, /^\| region \| total \| n \|\n\| --- \| --- \| --- \|\n\| south \|/);
    assert.equal(output.rowsOmitted, undefined);
    assert.equal(output.opStats[0].outputRows, 2);
});

test('a large result is not inlined', async () => {
    const { deps } = makeDeps({ limits: { inlineRows: 10 } });
    const { output } = await execTable(step([]), CTX, state(), 'live', deps);
    assert.equal(output.rowCount, 30);
    assert.equal(output.rowsOmitted, true);
    assert.equal(output.rows, undefined);
    assert.equal(output.markdown, undefined);
});

test('inlineRows 0 never inlines', async () => {
    const { deps } = makeDeps({ limits: { inlineRows: 0 } });
    const { output } = await execTable(step([{ op: 'sample', n: 2 }]), CTX, state(), 'live', deps);
    assert.equal(output.rowsOmitted, true);
});

test('the table is named after the step label when no name is set', async () => {
    const { deps, calls } = makeDeps();
    await execTable(step([]), CTX, state(), 'live', deps);
    assert.equal(calls.write[0].name, 'Edit table');
});

test('a source that carries .table is accepted', async () => {
    const { deps } = makeDeps();
    const rs = state();
    rs.steps.s1.output = { table: HANDLE, rowCount: 3 };
    const direct = step([{ op: 'sample', n: 1 }], { source: { kind: 'ref', path: 'steps.s1.output' } });
    const { output } = await execTable(direct, CTX, rs, 'live', deps);
    assert.equal(output.rowCount, 1);
});

test('segments and the description come through', async () => {
    const { deps } = makeDeps();
    const { output } = await execTable(step([{ op: 'groups', minN: 5, splits: [{ column: 'region' }] }, { id: 'x', enabled: false, op: 'describe' }]), CTX, state(), 'live', deps);
    assert.equal(output.segments.length, 3);
    assert.equal(output.description, undefined);
    const d = await execTable(step([{ op: 'describe' }]), CTX, state(), 'live', deps);
    assert.equal(d.output.description.rowCount, 30);
});

test('the organisation floor is looked up and applied', async () => {
    const { deps, calls } = makeDeps({ floor: 15 });
    const { output } = await execTable(step([{ op: 'groups', minN: 1, includeTotal: false, splits: [{ column: 'region' }] }]), CTX, state(), 'live', deps);
    assert.deepEqual(calls.floor, ['org1']);
    assert.deepEqual(output.rows.map((r) => r.suppressed), [false, true]);
    assert.equal(output.segments.length, 1);
});

test('warnings are recorded on the run with the step id', async () => {
    const { deps } = makeDeps({ floor: 15 });
    const rs = state();
    const { output } = await execTable(step([{ op: 'groups', minN: 1, includeTotal: false, splits: [{ column: 'region' }] }]), CTX, rs, 'live', deps);
    assert.equal(output.warnings.length, 1);
    assert.equal(rs._templateWarnings[0], `s2: ${output.warnings[0]}`);
});

test('join with a list of rows reads the list; a table handle goes through openTable', async () => {
    const { deps, calls } = makeDeps({ rows: ROWS.slice(0, 3) });
    const rs = state();
    rs.steps.dt = { output: { rows: [{ region: 'north', boss: 'Person One' }, { region: 'south', boss: 'Person Two' }] } };
    rs.steps.other = { output: { table: { ...HANDLE, tableId: 'rtb_' + 'c'.repeat(32) } } };
    const viaList = await execTable(step([{ op: 'join', with: { kind: 'ref', path: 'steps.dt.output.rows' }, on: [{ left: 'region', right: 'region' }] }]), CTX, rs, 'live', deps);
    assert.deepEqual(viaList.output.rows.map((r) => r.boss), ['Person Two', 'Person One', 'Person One']);
    const before = calls.open.length;
    await execTable(step([{ op: 'join', with: { kind: 'ref', path: 'steps.other.output.table' }, on: [{ left: 'region', right: 'region' }] }]), CTX, rs, 'live', deps);
    assert.equal(calls.open.length - before, 2);
    assert.equal(calls.open.at(-1).h.tableId, 'rtb_' + 'c'.repeat(32));
});

test('join with accepts {rows}, {columns, rows} and a Code step envelope as well as a plain list', async () => {
    const owners = [{ region: 'north', boss: 'Person One' }, { region: 'south', boss: 'Person Two' }];
    const shapes = {
        rows: { rows: owners },
        declared: { columns: [{ key: 'region' }, { key: 'boss' }], rows: owners.map((o) => [o.region, o.boss]) },
        envelope: { result: owners, logs: [], httpCalls: [] },
        envelopeRows: { result: { rows: owners }, logs: [], httpCalls: [] },
    };
    for (const [name, shape] of Object.entries(shapes)) {
        const { deps } = makeDeps({ rows: ROWS.slice(0, 3) });
        const rs = state();
        rs.steps.dt = { output: shape };
        const out = await execTable(step([{ op: 'join', with: { kind: 'ref', path: 'steps.dt.output' }, on: [{ left: 'region', right: 'region' }] }]), CTX, rs, 'live', deps);
        assert.deepEqual(out.output.rows.map((r) => r.boss), ['Person Two', 'Person One', 'Person One'], name);
    }
});

test('join with a value that is not a table or a list names the problem', async () => {
    const { deps } = makeDeps({ rows: ROWS.slice(0, 3) });
    const rs = state();
    rs.steps.dt = { output: { text: 'hello' } };
    await assert.rejects(
        execTable(step([{ op: 'join', with: { kind: 'ref', path: 'steps.dt.output' }, on: [{ left: 'region', right: 'region' }] }]), CTX, rs, 'live', deps),
        (e) => e.errorClass === 'table_op_invalid' && e.field === 'with',
    );
});

test('an expired or foreign table is table_not_found', async () => {
    const { deps, calls } = makeDeps({ expired: true });
    await assert.rejects(execTable(step([]), CTX, state(), 'live', deps), (e) => e.errorClass === 'table_not_found' && /expired or belongs to another run/.test(e.message));
    assert.equal(calls.write.length, 0);
});

test('an unresolved source is skipped with a sentence naming the path', async () => {
    const { deps, calls } = makeDeps();
    const r = await execTable(step([]), CTX, { vars: {}, steps: {} }, 'live', deps);
    assert.equal(r.skippedReason, 'table_source_unresolved');
    assert.match(r.output.skipped, /`steps\.s1\.output\.table` did not resolve to one \(found nothing\)/);
    assert.equal(calls.open.length + calls.write.length, 0);
    const text = await execTable(step([]), CTX, state('not a table'), 'live', deps);
    assert.equal(text.skippedReason, 'table_source_unresolved');
});

test('a dry run plans the columns and never touches storage', async () => {
    const { deps, calls } = makeDeps();
    const r = await execTable(step([{ op: 'select', keep: ['amount'] }, { op: 'derive', columns: [{ name: 'double', value: 1 }] }], { name: 'Planned' }), CTX, state(), 'dry_run', deps);
    assert.equal(r.dryRunSynthesised, true);
    assert.equal(r.output._dryRun, true);
    assert.equal(r.output.table.tableId, 'dry-run');
    assert.equal(r.output.table.name, 'Planned');
    assert.deepEqual(r.output.table.columns.map((c) => c.key), ['amount', 'double']);
    assert.deepEqual([r.output.rowCount, r.output.rows, r.output.markdown], [0, [], '']);
    assert.equal(calls.open.length + calls.write.length + calls.floor.length, 0);
});

test('a dry run after a pivot has no planned columns', async () => {
    const { deps } = makeDeps();
    const r = await execTable(step([{ op: 'pivot', rows: 'region', columns: 'amount' }]), CTX, state(), 'dry_run', deps);
    assert.deepEqual(r.output.table.columns, []);
});

test('too many operations is table_op_invalid', async () => {
    const { deps } = makeDeps({ limits: { maxOps: 1 } });
    await assert.rejects(execTable(step([{ op: 'sample', n: 1 }, { op: 'sample', n: 1 }]), CTX, state(), 'live', deps), (e) => e.errorClass === 'table_op_invalid');
});

test('an engine error keeps its class, operation and field', async () => {
    const { deps, calls } = makeDeps();
    await assert.rejects(execTable(step([{ id: 'pick', op: 'select', keep: ['ghost'] }]), CTX, state(), 'live', deps), (e) => e.errorClass === 'table_op_invalid' && e.opId === 'pick' && e.field === 'keep[0]');
    assert.equal(calls.write.length, 0);
});

// ── a list of rows (Code step output) as the source ──
const listState = (output) => ({ vars: {}, steps: { s1: { output } }, _templateWarnings: [] });
const listStep = (ops = [{ op: 'filter', where: [] }], extra = {}) => ({ id: 's2', type: 'table', label: 'Edit table', source: { kind: 'ref', path: 'steps.s1.output.result' }, ops, ...extra });
const { listToTable } = require('./tables/listSource');
const LIST = [{ name: 'Ann', amount: 3, ok: true }, { name: 'Bo', amount: 5, ok: false }];
const withList = (over = {}) => {
    const made = makeDeps({ limits: over.limits });
    made.deps.listToTable = listToTable;
    return made;
};

test('an array of objects becomes a source table with inferred column types', async () => {
    const { deps, calls } = withList();
    const { output } = await execTable(listStep(), CTX, listState({ result: LIST, logs: [], httpCalls: 0 }), 'live', deps);
    assert.equal(calls.open.length, 0);
    assert.equal(calls.write.length, 2); // the source table, then the result
    assert.deepEqual(calls.write[0].columns.map((c) => [c.key, c.type]), [['name', 'text'], ['amount', 'number'], ['ok', 'boolean']]);
    assert.equal(output.rowCount, 2);
});

test('{columns, rows} keeps the column order and accepts rows as arrays', async () => {
    const { deps, calls } = withList();
    const out = { columns: [{ key: 'b', label: 'B' }, { key: 'a', type: 'text' }], rows: [[1, 'x'], [2, 'y']] };
    await execTable(listStep(), CTX, listState({ result: out }), 'live', deps);
    assert.deepEqual(calls.write[0].columns.map((c) => [c.key, c.label, c.type]), [['b', 'B', 'number'], ['a', 'a', 'text']]);
    const rows = []; for await (const r of calls.write[0].rows) rows.push(r);
    assert.deepEqual(rows, [{ b: 1, a: 'x' }, { b: 2, a: 'y' }]);
});

test('{rows} and a code envelope around it work', () => {
    assert.equal(listToTable({ rows: LIST }).rows.length, 2);
    const t = listToTable({ result: { rows: LIST }, logs: [], httpCalls: 1 });
    assert.deepEqual(t.columns.map((c) => c.key), ['name', 'amount', 'ok']);
    assert.equal(listToTable('text'), null);
    assert.equal(listToTable({ other: 1 }), null);
});

test('rows that are not records are refused in plain words', async () => {
    const { deps } = withList();
    await assert.rejects(execTable(listStep(), CTX, listState({ result: [{ a: 1 }, 'oops'], logs: [], httpCalls: 0 }), 'live', deps),
        (e) => e.errorClass === 'table_source_invalid' && /Row 2 is a string, not a record/.test(e.message));
});

test('more rows than AUTOMATION_TABLE_MAX_ROWS is refused', async () => {
    const { deps } = withList({ limits: { maxRows: 1 } });
    await assert.rejects(execTable(listStep(), CTX, listState({ result: LIST }), 'live', deps),
        (e) => e.errorClass === 'table_too_large' && /AUTOMATION_TABLE_MAX_ROWS/.test(e.message));
});

test('a dry run plans the columns from the list without writing', async () => {
    const { deps, calls } = withList();
    const { output } = await execTable(listStep(), CTX, listState({ result: LIST, logs: [], httpCalls: 0 }), 'dry_run', deps);
    assert.equal(calls.write.length, 0);
    assert.equal(output._dryRun, true);
    assert.deepEqual(output.columns.map((c) => c.key), ['name', 'amount', 'ok']);
});

test('a value that is neither a table nor a list is still skipped', async () => {
    const { deps } = withList();
    const r = await execTable(listStep(), CTX, listState('nope'), 'live', deps);
    assert.equal(r.skippedReason, 'table_source_unresolved');
});
