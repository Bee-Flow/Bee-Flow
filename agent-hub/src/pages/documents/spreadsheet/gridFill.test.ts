import { describe, expect, it } from 'vitest';
import { autoSumChanges, fillChanges } from './gridFill';

const grid = (cells: Record<string, string>) => (col: number, row: number) => cells[`${String.fromCharCode(65 + col)}${row + 1}`] ?? '';
const numeric = (cells: Record<string, string>) => (col: number, row: number) => /^\d+$/.test(grid(cells)(col, row));

describe('fillChanges', () => {
    it('fills the first row down with shifted references and leaves absolute ones', () => {
        const raw = grid({ B1: '=A1*$D$1', B2: 'old' });
        expect(fillChanges({ c1: 1, r1: 0, c2: 1, r2: 2 }, 'down', raw)).toEqual({ B2: '=A2*$D$1', B3: '=A3*$D$1' });
    });

    it('fills the first column right, and skips cells that already read the same', () => {
        const raw = grid({ A1: '=A2', B1: '=B2' });
        expect(fillChanges({ c1: 0, r1: 0, c2: 2, r2: 0 }, 'right', raw)).toEqual({ C1: '=C2' });
    });

    it('does nothing for one cell on the first row or column', () => {
        expect(fillChanges({ c1: 0, r1: 0, c2: 0, r2: 0 }, 'down', grid({}))).toEqual({});
        expect(fillChanges({ c1: 0, r1: 4, c2: 0, r2: 4 }, 'right', grid({}))).toEqual({});
    });
});

describe('autoSumChanges', () => {
    const cells = { A1: 'h', A2: '1', A3: '2', B3: '5' };
    it('sums the contiguous numbers above an empty cell', () => {
        expect(autoSumChanges({ c1: 0, r1: 3, c2: 0, r2: 3 }, null, 3, grid(cells), numeric(cells))).toEqual({ A4: '=SUM(A2:A3)' });
    });

    it('falls back to the numbers on the left, and writes a lone number as a lone reference', () => {
        expect(autoSumChanges({ c1: 2, r1: 2, c2: 2, r2: 2 }, null, 3, grid(cells), numeric(cells))).toEqual({ C3: '=SUM(A3:B3)' });
        expect(autoSumChanges({ c1: 2, r1: 2, c2: 2, r2: 2 }, null, 3, grid({ B3: '5' }), numeric({ B3: '5' }))).toEqual({ C3: '=SUM(B3)' });
    });

    it('puts the total of a selected block per column into its empty last row', () => {
        expect(autoSumChanges({ c1: 0, r1: 1, c2: 1, r2: 3 }, null, 3, grid(cells), numeric(cells))).toEqual({ A4: '=SUM(A2:A3)', B4: '=SUM(B2:B3)' });
    });

    it('totals whole columns under their used rows and ignores whole rows', () => {
        expect(autoSumChanges({ c1: 0, r1: 0, c2: 0, r2: 49 }, 'columns', 3, grid(cells), numeric(cells))).toEqual({ A4: '=SUM(A1:A3)' });
        expect(autoSumChanges({ c1: 0, r1: 2, c2: 25, r2: 2 }, 'rows', 3, grid(cells), numeric(cells))).toEqual({});
    });
});
