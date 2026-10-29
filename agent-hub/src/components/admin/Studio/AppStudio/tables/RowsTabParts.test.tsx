import { afterEach, describe, expect, it, vi } from 'vitest';
import toast from '@/components/shared/Toast';
import { reportCellSaveError, rowCountLabelFor } from './RowsTabParts';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { RowRecord } from './recordsApi';

const t: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : '';
    const values = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(values[name] ?? ''));
};

afterEach(() => { vi.restoreAllMocks(); });

describe('rowCountLabelFor', () => {
    it('says one row or many, and "so far" while there are more pages', () => {
        expect(rowCountLabelFor(t, 1, null, 'Tasks')).toBe('1 row in Tasks');
        expect(rowCountLabelFor(t, 1, 'c1', 'Tasks')).toBe('1 row so far in Tasks');
        expect(rowCountLabelFor(t, 3, null, 'Tasks')).toBe('3 rows in Tasks');
        expect(rowCountLabelFor(t, 0, 'c1', 'Tasks')).toBe('0 rows so far in Tasks');
    });
});

describe('reportCellSaveError', () => {
    it('replaces the row with the winning version on a conflict', () => {
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        let rows: RowRecord[] = [{ id: 'a', name: 'mine' }, { id: 'b', name: 'other' }];
        const setRows = (next: RowRecord[] | ((cur: RowRecord[]) => RowRecord[])) => {
            rows = typeof next === 'function' ? next(rows) : next;
        };
        reportCellSaveError({ code: 'record_conflict', body: { record: { id: 'a', name: 'theirs' } } }, 'a', setRows, t);
        expect(rows).toEqual([{ id: 'a', name: 'theirs' }, { id: 'b', name: 'other' }]);
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/Someone else changed this row/));
    });

    it('shows the error message otherwise and leaves the rows alone', () => {
        const error = vi.spyOn(toast, 'error').mockImplementation(() => 0);
        const setRows = vi.fn();
        reportCellSaveError(new Error('boom'), 'a', setRows, t);
        expect(setRows).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith('boom');
    });
});
