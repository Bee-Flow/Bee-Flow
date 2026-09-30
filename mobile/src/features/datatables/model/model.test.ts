/** The smaller pure pieces: who may edit, widening, the grid, the import plan, the words. */

import type { TranslateFn } from '@/core/i18n';

import { canEditTable, widens } from './access';
import { columnProblem, draftOf } from './columns';
import { columnWidth, gridWidth, stampText } from './grid';
import { importOutcome, planImport } from './importPlan';
import type { Column, Datatable } from './types';
import { audienceLabel, cellErrorText, describeAccess, joinNames, opLabel, rowsWord, siteText } from './words';

/** The catalogue's fallback with its {placeholders} filled — what the phone shows before a translation lands. */
const t: TranslateFn = (_key, fallback, params) =>
    fallback.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));

const table = (over: Partial<Datatable> = {}): Datatable => ({
    id: 'tbl_1', name: 'Leads', key: 'leads', description: '', rowCount: 0, rowScope: 'all', isPublished: false,
    sharedGroups: [], writeMode: 'grants', retentionDays: null, retentionField: null, lastRetentionAt: null, managedKind: null, sourceWritable: null,
    ownerUserId: 'u1', updatedAt: null, scopeKind: 'org', grade: 'owner', usageCount: 0, ...over,
});

describe('access', () => {
    it('lets the owner edit, needing manage_datatables only on an organisation table', () => {
        expect(canEditTable(table(), false)).toBe(false);
        expect(canEditTable(table(), true)).toBe(true);
        expect(canEditTable(table({ scopeKind: 'user' }), false)).toBe(true);
        expect(canEditTable(table({ grade: 'editor' }), true)).toBe(false);
    });

    it('asks before widening only', () => {
        expect(widens('private', 'groups')).toBe(true);
        expect(widens('groups', 'org')).toBe(true);
        expect(widens('org', 'groups')).toBe(false);
        expect(widens('groups', 'private')).toBe(false);
    });
});

describe('columns', () => {
    it('says the first problem as a code', () => {
        expect(columnProblem([{ key: 'a', type: 'text' }, { key: 'a', type: 'text' }])).toEqual({ code: 'duplicate_key', column: 'a' });
        expect(columnProblem([{ key: 'created_at', type: 'text' }])).toEqual({ code: 'system_key', column: 'created_at' });
        expect(columnProblem([{ key: 's', type: 'select' }])).toEqual({ code: 'no_options', column: 's' });
    });

    it('turns a stored column back into what a save sends, id kept', () => {
        const c: Column = { id: 'fld_1', key: 'stage', name: 'Stage', type: 'select', options: ['a'], required: true, unique: false };
        expect(draftOf(c)).toEqual({ id: 'fld_1', key: 'stage', name: 'Stage', type: 'select', options: ['a'], required: true });
        expect(draftOf({ ...c, type: 'relation', options: [] }).type).toBe('text');
    });
});

describe('grid', () => {
    it('sizes columns by type and adds the Added column', () => {
        expect(columnWidth({ type: 'bool' })).toBeLessThan(columnWidth({ type: 'text' }));
        expect(gridWidth([])).toBeGreaterThan(0);
        expect(gridWidth([{ type: 'bool' }])).toBeGreaterThan(gridWidth([]));
        expect(stampText('2026-03-14T09:30:12.000Z')).toBe('2026-03-14 09:30');
        expect(stampText(null)).toBe('—');
    });
});

describe('importPlan', () => {
    it('sends only clean rows and maps the server’s lines back to the file’s', () => {
        const plan = planImport([
            { line: 2, values: { a: 1 }, problems: [] },
            { line: 3, values: {}, problems: [{ column: 'A', error: { code: 'number', text: 'x' } }] },
            { line: 4, values: {}, problems: [] },
            { line: 5, values: { a: 2 }, problems: [] },
        ]);
        expect(plan.good.map((r) => r.line)).toEqual([2, 5]);
        const outcome = importOutcome(plan, { inserted: 1, errors: [{ line: 2, error: 'bad' }] });
        expect(outcome).toEqual({
            inserted: 1,
            failed: [
                { line: 3, problems: [{ column: 'A', error: { code: 'number', text: 'x' } }] },
                { line: 5, problems: [], error: 'bad' },
            ],
        });
    });
});

describe('words', () => {
    it('groups row counts and joins names', () => {
        expect(rowsWord(t, 1)).toBe('1 row');
        expect(rowsWord(t, 1284)).toBe(`${(1284).toLocaleString()} rows`);
        expect(joinNames(t, ['a', 'b', 'c'])).toBe('a, b and c');
        expect(joinNames(t, ['a'])).toBe('a');
    });

    it('says Personal for a personal table, never Private', () => {
        expect(audienceLabel(t, table({ scopeKind: 'user' }))).toBe('Personal');
        expect(audienceLabel(t, table({ isPublished: true }))).toBe('Whole organisation');
    });

    it('describes reading and writing as two things', () => {
        const groups = describeAccess(t, table({ isPublished: true, sharedGroups: ['g1', 'g2'] }), (id) => id.toUpperCase());
        expect(groups).toEqual({ readers: 'Members of G1 and G2', writers: 'only the people you invite', broad: false });
        expect(describeAccess(t, table({ isPublished: true, writeMode: 'audience' }), String).broad).toBe(true);
        expect(describeAccess(t, table({ writeMode: 'audience' }), String).writers).toBe('the same people');
    });

    it('words operators, cell errors and usage sites', () => {
        expect(opLabel(t, 'notContains')).toBe('does not contain');
        expect(opLabel(t, 'future')).toBe('future');
        expect(cellErrorText(t, 'number', 'x')).toBe('“x” is not a number');
        const row = { consumerKind: 'automation', consumerId: 'a1', title: 'T', ownerId: null, mode: 'read' as const, stepOrdinal: 3, stepOp: 'insert_row', columns: [], lastRunAt: null };
        expect(siteText(t, row)).toBe('step 3 · insert row');
        expect(siteText(t, { ...row, stepOrdinal: null, stepOp: null, columns: ['a', 'b'] })).toBe('a, b');
    });
});
