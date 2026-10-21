import { describe, expect, it } from 'vitest';
import { buildStepFromPayload } from '../applyAddNode';
import { describeNode } from '../mapping/upstream/describeNode';
import { itemForKey } from './stepPalette';
import { tableOptions } from './settings/tableEditor/TableSourceField';
import { readTableSummary, tableSummary } from './tableSummaries';

const t = (_key: string, fallback: string, vars?: Record<string, unknown>) => fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(vars?.[name] ?? ''));
const SOURCE = { kind: 'ref', path: 'steps.read.output.table' };

describe('the cards of the spreadsheet steps', () => {
    it('say what a Read table step opens', () => {
        expect(readTableSummary({ source: null, sheets: 'all' }, t)).toEqual({ muted: 'Pick a file' });
        expect(readTableSummary({ source: SOURCE, sheets: 'all' }, t)).toBe('All sheets');
        expect(readTableSummary({ source: SOURCE, sheets: 'first' }, t)).toBe('First sheet');
        expect(readTableSummary({ source: SOURCE, sheets: ['Sales'] }, t)).toBe('Sheet Sales');
        expect(readTableSummary({ source: SOURCE, sheets: ['A', 'B', 'C'] }, t)).toBe('3 chosen sheets');
    });

    it('say how many steps an Edit table step has and name the first two', () => {
        expect(tableSummary({ source: null, ops: [] }, t)).toEqual({ muted: 'Pick a table' });
        expect(tableSummary({ source: SOURCE, ops: [] }, t)).toEqual({ muted: 'No steps yet' });
        expect(tableSummary({ source: SOURCE, ops: [{ op: 'filter' }, { op: 'group' }, { op: 'pivot' }] }, t))
            .toBe('3 steps: Keep rows that match · Group and count …');
    });
});

describe('adding the spreadsheet steps', () => {
    it('are in the palette under their server names', () => {
        expect(itemForKey('step:read_table')?.payload).toMatchObject({ kind: 'read_table', label: 'Read table' });
        expect(itemForKey('step:table')?.payload).toMatchObject({ kind: 'table', label: 'Edit table' });
    });

    it('start from the defaults of the server', () => {
        expect(buildStepFromPayload({ kind: 'read_table', label: 'Read table' })).toMatchObject({
            type: 'read_table', label: 'Read table', source: null, sheets: 'all', headerRow: 1, provenanceSheet: 'auto',
            format: 'auto', delimiter: 'auto', skipHiddenSheets: true, expiresInDays: 7,
        });
        expect(buildStepFromPayload({ kind: 'table', label: 'Edit table' })).toMatchObject({
            type: 'table', label: 'Edit table', source: null, ops: [], expiresInDays: 7,
        });
    });
});

describe('what the steps hand on', () => {
    const read = { id: 'read', type: 'read_table', label: 'Read table' };

    it('is a table for the next step to pick', () => {
        const group = describeNode(read as never, { steps: [read] } as never, new Map(), {}, null, null) as { kind: string; basePath: string; fields: { key: string }[] };
        expect(group.kind).toBe('read_table');
        expect(group.basePath).toBe('steps.read.output');
        expect(group.fields.map(f => f.key)).toEqual(expect.arrayContaining(['table', 'tables', 'tablesByName', 'sheets']));
        const edit = describeNode({ id: 'edit', type: 'table', label: 'Edit table' } as never, { steps: [] } as never, new Map(), {}, null, null) as { kind: string; fields: { key: string }[] };
        expect(edit.kind).toBe('table');
        expect(edit.fields.map(f => f.key)).toEqual(expect.arrayContaining(['table', 'rowCount', 'columns', 'rows']));
    });

    it('is listed as a table to work on, the nearest step last', () => {
        const groups = [
            { id: 'read', label: 'Read table', kind: 'read_table', basePath: 'steps.read.output', sample: {} },
            { id: 'form', label: 'Form', kind: 'trigger', basePath: 'trigger.output', sample: {} },
            { id: 'edit', label: 'Edit table', kind: 'table', basePath: 'steps.edit.output', sample: {} },
        ];
        expect(tableOptions(groups).map(o => o.path)).toEqual(['steps.read.output.table', 'steps.edit.output.table']);
    });
});
