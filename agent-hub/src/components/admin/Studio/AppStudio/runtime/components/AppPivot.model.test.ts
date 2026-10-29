import { describe, it, expect } from 'vitest';
import { buildPivotModel } from './AppPivot';
import { EM_DASH } from '../uiBits';

const rows = [
    { region: 'North', year: 2025, amount: 10 },
    { region: 'South', year: 2024, amount: 5 },
    { region: 'North', year: 2024, amount: 7 },
    { region: '', year: 2025, amount: 1 },
];

describe('buildPivotModel', () => {
    it('groups rows by the row dimensions in first-seen order, an empty value as the dash', () => {
        const m = buildPivotModel(rows, [{ key: 'region' }], []);
        expect(m.rowGroups.map((g) => g.values)).toEqual([['North'], ['South'], [EM_DASH]]);
        expect(m.rowGroups[0].rows).toHaveLength(2);
        expect(m.colGroups).toEqual([]);
        expect(m.allRows).toHaveLength(4);
        expect(m.hiddenCols).toBe(0);
    });

    it('buckets each row into its column group, sorted by key, per row group and overall', () => {
        const m = buildPivotModel(rows, [{ key: 'region' }], [{ key: 'year' }]);
        expect(m.colGroups.map((c) => c.values)).toEqual([['2024'], ['2025']]);
        const north = m.rowGroups[0];
        expect(north.byCol.get('2024')).toEqual([rows[2]]);
        expect(north.byCol.get('2025')).toEqual([rows[0]]);
        expect(m.allByCol.get('2025')).toEqual([rows[0], rows[3]]);
    });

    it('ignores what is not a row, and reads a non-array source as empty', () => {
        expect(buildPivotModel([null, 3, rows[0]], [{ key: 'region' }], []).allRows).toEqual([rows[0]]);
        expect(buildPivotModel(undefined, [{ key: 'region' }], []).rowGroups).toEqual([]);
    });

    it('caps the column groups and says how many it dropped', () => {
        const many = Array.from({ length: 65 }, (_, i) => ({ k: 'a', c: `c${String(i).padStart(2, '0')}` }));
        const m = buildPivotModel(many, [{ key: 'k' }], [{ key: 'c' }]);
        expect(m.colGroups).toHaveLength(60);
        expect(m.hiddenCols).toBe(5);
    });
});
