import { describe, expect, it } from 'vitest';
import type { TableColumn } from '@/api/queries/automation/runTables';
import type { OpResult } from '@/api/queries/automation/tablePreview';
import {
    claims, columnsInto, duplicateOp, handleOf, issuesOf, moveOp, newOp, newOpId, OP_KINDS, planOpColumns, splitPath, withDefaults,
    type TableOp,
} from './tableOpModel';

const col = (key: string, type: TableColumn['type'] = 'text'): TableColumn => ({ key, label: key, type });
const SOURCE = [col('Region'), col('Amount', 'number'), col('Email')];

/**
 * The starting values of every operation, listed once and literally. They are
 * the defaults the server fills in (core/automationModel/tableOps/normalize.js),
 * so a step the editor makes reads the same as one the server normalised.
 * `sample` is the one exception: the server has no default there and wants
 * exactly one of `n` and `percent`, so a new one starts on the first 100 rows.
 */
const STARTING = {
    join: { with: null, how: 'left', on: [{ left: '', right: '' }], caseInsensitive: true, trim: true, columns: null, prefix: '', onDuplicate: 'first' },
    pseudonymise: { columns: [], saltVar: '', output: 'pseudonym', length: 16, keepColumns: false, dropColumns: [] },
    derive: { columns: [{ name: '', value: null }] },
    bucket: { column: '', output: '', mode: 'bands', bands: [{ label: '', min: null, max: null }], quantiles: 4, labels: null, map: [], otherLabel: 'Other' },
    group: { by: [], aggregates: [{ fn: 'count', as: 'Count' }], weight: null, minN: 0, sort: [] },
    pivot: { rows: '', columns: '', value: { fn: 'count' }, weight: null, percent: 'none', totals: true, minN: 0, decimals: 1, columnOrder: null, missingLabel: '(empty)' },
    filter: { match: 'all', rules: [], rulesFrom: null, rulesFromMatch: 'all', expr: null },
    select: { keep: null, drop: null, rename: [] },
    sample: { mode: 'first', n: 100, percent: null, seed: 'sample' },
    groups: { splits: [{ column: '', values: null, separator: null, label: null }], includeTotal: true, totalLabel: 'All', minN: 30 },
    describe: { columns: null, maxOptions: 50, separator: null, sampleValues: 5 },
} as const;

describe('new operations', () => {
    it('start from the defaults of the server spec', () => {
        expect(Object.keys(STARTING).sort()).toEqual([...OP_KINDS].sort());
        for (const kind of OP_KINDS) {
            expect(newOp(kind, [])).toEqual({ id: 'op1', op: kind, enabled: true, ...STARTING[kind] });
        }
    });

    it('get an id nobody has', () => {
        expect(newOpId([{ id: 'op1' }, { id: 'op3' }])).toBe('op4');
        expect(newOpId([{ id: 'op2' }])).toBe('op3');
        expect(newOpId([])).toBe('op1');
    });

    it('are filled up when an older step lacks a setting', () => {
        const op = withDefaults({ id: 'a', op: 'group', by: ['Region'] } as never);
        expect(op).toMatchObject({ id: 'a', enabled: true, by: ['Region'], minN: 0, weight: null, sort: [] });
    });

    it('keep a stored percentage as the way to size a sample', () => {
        const op = withDefaults({ id: 'a', op: 'sample', percent: 10 } as never);
        expect(op).toMatchObject({ n: null, percent: 10 });
    });
});

describe('the list of operations', () => {
    const ops = ['a', 'b', 'c'].map(id => ({ ...newOp('filter', []), id }));

    it('moves one operation to another place', () => {
        expect(moveOp(ops, 0, 2).map(o => o.id)).toEqual(['b', 'c', 'a']);
        expect(moveOp(ops, 2, 1).map(o => o.id)).toEqual(['a', 'c', 'b']);
        expect(moveOp(ops, 0, 5).map(o => o.id)).toEqual(['a', 'b', 'c']);
    });

    it('duplicates an operation right after itself, with its own id', () => {
        const next = duplicateOp(ops, 1);
        expect(next.map(o => o.id)).toEqual(['a', 'b', 'op4', 'c']);
        expect(next[2]).toMatchObject({ op: 'filter', rules: [] });
    });
});

describe('columns that flow through the operations', () => {
    const group: TableOp = { ...newOp('group', []), id: 'g', by: ['Region'], aggregates: [{ fn: 'sum', column: 'Amount', as: 'Total' }] } as TableOp;
    const derive: TableOp = { ...newOp('derive', [group]), id: 'd', columns: [{ name: 'Half', value: null }] } as TableOp;
    const drop: TableOp = { ...newOp('select', []), id: 's', drop: ['Email'] } as TableOp;

    it('plans the columns after an operation from its settings', () => {
        expect(planOpColumns(SOURCE, group)?.map(c => c.key)).toEqual(['Region', 'Total', 'n', 'suppressed']);
        expect(planOpColumns(SOURCE, derive)?.map(c => c.key)).toEqual(['Region', 'Amount', 'Email', 'Half']);
        expect(planOpColumns(SOURCE, drop)?.map(c => c.key)).toEqual(['Region', 'Amount']);
        expect(planOpColumns(SOURCE, { ...newOp('pivot', []), id: 'p' })).toBeNull();
    });

    it('leaves an operation that is switched off out of the plan', () => {
        expect(planOpColumns(SOURCE, { ...group, enabled: false })).toEqual(SOURCE);
    });

    it('feeds an operation the columns the previous one left', () => {
        const ops = [group, derive];
        expect(columnsInto(SOURCE, ops, 0)).toEqual(SOURCE);
        expect(columnsInto(SOURCE, ops, 1)?.map(c => c.key)).toEqual(['Region', 'Total', 'n', 'suppressed']);
        expect(columnsInto(null, ops, 1)).toBeNull();
    });

    it('trusts the preview over the plan', () => {
        const results: OpResult[] = [{ opId: 'g', op: 'group', enabled: true, ok: true, inputRows: 10, outputRows: 2, columns: ['Region', 'Total'], warnings: [] }];
        expect(columnsInto(SOURCE, [group, derive], 1, results)?.map(c => c.key)).toEqual(['Region', 'Total']);
    });

    it('knows the columns after a pivot only from the preview', () => {
        const pivot = { ...newOp('pivot', []), id: 'p' } as TableOp;
        expect(columnsInto(SOURCE, [pivot, derive], 1)).toBeNull();
        const results: OpResult[] = [{ opId: 'p', op: 'pivot', enabled: true, ok: true, inputRows: 4, outputRows: 2, columns: ['Region', 'North', 'South'], warnings: [] }];
        expect(columnsInto(SOURCE, [pivot, derive], 1, results)?.map(c => c.key)).toEqual(['Region', 'North', 'South']);
    });
});

describe('findings', () => {
    it('are split into the operation and the field they name', () => {
        expect(splitPath('ops[2].by[0]')).toEqual({ index: 2, rest: 'by[0]' });
        expect(splitPath('ops[0]')).toEqual({ index: 0, rest: '' });
        expect(splitPath('source')).toBeNull();
    });

    it('belong to the field, or to what is inside it', () => {
        expect(claims('by[0]', 'by')).toBe(true);
        expect(claims('on[1].left', 'on[1].left')).toBe(true);
        expect(claims('on[1].left', 'on', true)).toBe(false);
        expect(claims('bypass', 'by')).toBe(false);
    });

    it('are collected for one operation, an engine error included', () => {
        const findings = [
            { code: 'table.column_missing', severity: 'error' as const, path: 'ops[1].by[0]', message: 'No such column' },
            { code: 'table.column_missing', severity: 'error' as const, path: 'ops[0].rows', message: 'Elsewhere' },
        ];
        const results: OpResult[] = [{ opId: 'b', op: 'group', enabled: true, ok: false, inputRows: 3, outputRows: 0, columns: [], warnings: [], error: { code: 'table_op_invalid', field: 'weight', message: 'Not a number' } }];
        const issues = issuesOf(1, 'b', findings, results);
        expect(issues.map(i => [i.rest, i.message])).toEqual([['by[0]', 'No such column'], ['weight', 'Not a number']]);
    });
});

describe('table handles', () => {
    const handle = { kind: 'table', tableId: 'rtb_' + 'a'.repeat(32), runId: 'run1', name: 'Sheet1', columns: [col('A')], rowCount: 2, preview: [], expiresAt: null, provenance: null };

    it('are found as they are, or as the table of a step output', () => {
        expect(handleOf(handle)).toMatchObject({ runId: 'run1', tableId: handle.tableId });
        expect(handleOf({ table: handle, rowCount: 2 })).toMatchObject({ runId: 'run1' });
    });

    it('are not previewable when no run made them', () => {
        expect(handleOf({ ...handle, tableId: 'dry-run', runId: null })).toBeNull();
        expect(handleOf({ kind: 'file' })).toBeNull();
        expect(handleOf(null)).toBeNull();
    });
});
