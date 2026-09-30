/** A row's editors and what they send: every type converted, an edit sends only what moved. */

import { convertDraftValue, draftFromRow, editableColumns, valuesFromDraft } from './rowDraft';
import type { Column, TableRow } from './types';

const col = (key: string, type: Column['type'], extra: Partial<Column> = {}): Column => ({
    id: `fld_${key}`, key, name: key, type, options: [], required: false, unique: false, ...extra,
});

const COLUMNS = [
    col('name', 'text', { required: true }),
    col('amount', 'number'),
    col('active', 'bool'),
    col('day', 'date'),
    col('at', 'datetime'),
    col('stage', 'select', { options: ['New', 'Won'] }),
    col('tags', 'multiselect', { options: ['a', 'b'] }),
    col('doc', 'file'),
    col('link', 'relation'),
];

const ROW: TableRow = {
    id: 'rec_1',
    updated_at: '2026-09-01T10:00:00.000Z',
    name: 'Anna',
    amount: '12.50',
    active: 1,
    day: '2026-03-14T00:00:00.000Z',
    at: '2026-03-14 09:30:00',
    stage: 'Won',
    tags: '["a"]',
    doc: 'x.pdf',
};

describe('rowDraft', () => {
    it('leaves out the columns a phone cannot fill in', () => {
        expect(editableColumns(COLUMNS).map((c) => c.key)).not.toEqual(expect.arrayContaining(['doc', 'link']));
    });

    it('seeds each editor from the row as Postgres answered it', () => {
        expect(draftFromRow(ROW, COLUMNS)).toEqual({
            name: 'Anna', amount: '12.50', active: true, day: '2026-03-14', at: '2026-03-14T09:30', stage: 'Won', tags: ['a'],
        });
        expect(draftFromRow(null, COLUMNS)).toEqual({ name: '', amount: '', active: false, day: '', at: '', stage: '', tags: [] });
    });

    it('converts numbers and dates the way the import reads them', () => {
        expect(convertDraftValue('12,5', COLUMNS[1]!)).toEqual({ value: 12.5, error: null });
        expect(convertDraftValue('twelve', COLUMNS[1]!)).toEqual({ value: null, error: 'number' });
        expect(convertDraftValue('14-03-2026', COLUMNS[3]!)).toEqual({ value: '2026-03-14', error: null });
        expect(convertDraftValue('2026-03-14 9:05', COLUMNS[4]!)).toEqual({ value: '2026-03-14T09:05', error: null });
        expect(convertDraftValue('soon', COLUMNS[4]!).error).toBe('datetime');
        expect(convertDraftValue('  ', COLUMNS[0]!)).toEqual({ value: null, error: 'required' });
        expect(convertDraftValue([], col('t', 'multiselect', { required: true })).error).toBe('required');
    });

    it('sends every filled-in column of a new row, and a yes/no always', () => {
        const draft = { ...draftFromRow(null, COLUMNS), name: 'Bob', amount: '3' };
        expect(valuesFromDraft(draft, COLUMNS, null)).toEqual({ values: { name: 'Bob', amount: 3, active: false }, errors: {} });
    });

    it('sends only what moved in an edit, including a value cleared to empty', () => {
        const original = draftFromRow(ROW, COLUMNS);
        const draft = { ...original, amount: '', tags: ['a', 'b'] };
        expect(valuesFromDraft(draft, COLUMNS, original)).toEqual({ values: { amount: null, tags: ['a', 'b'] }, errors: {} });
        expect(valuesFromDraft(original, COLUMNS, original).values).toEqual({});
    });

    it('names the editor that will not do instead of sending', () => {
        const draft = { ...draftFromRow(null, COLUMNS), amount: 'lots' };
        expect(valuesFromDraft(draft, COLUMNS, null).errors).toEqual({ name: 'required', amount: 'number' });
    });
});
