// The instant numbers of a selection (status bar): Sum, Average and Count of
// its numeric cells, read from the already evaluated values. Nothing is sent.

import type { Computed } from './sheetEngine';
import { cellName } from './sheetEngine';
import type { Range } from './sheetModel';

export interface SelectionStats { cells: number; count: number; sum: number; average: number }

export function selectionStats(r: Range, computed: Computed): SelectionStats {
    let count = 0;
    let sum = 0;
    for (let row = r.r1; row <= r.r2; row++) {
        for (let col = r.c1; col <= r.c2; col++) {
            const res = computed[cellName(col, row)];
            if (res && !res.error && typeof res.value === 'number' && Number.isFinite(res.value)) { count++; sum += res.value; }
        }
    }
    return { cells: (r.r2 - r.r1 + 1) * (r.c2 - r.c1 + 1), count, sum, average: count ? sum / count : 0 };
}
