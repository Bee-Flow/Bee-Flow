import { relationCellValue } from './relationLabel';
import type { LabelForCellArgs } from './cellValue.types';

/**
 * What a pill cell shows for its value (cellValue.tsx renders it).
 */

/** The label for one cell: a toneMap entry may relabel the stored value. */
export function labelForCell({ col, value }: LabelForCellArgs) {
    const map = col && Array.isArray(col.toneMap) ? col.toneMap : null;
    if (!map || value == null) return value;
    const hit = map.find((m) => m && String(m.value) === String(value));
    return hit && hit.label != null ? hit.label : value;
}

/**
 * The label of a `badge` or `relation` cell. A toneMap label wins on both; a
 * `relation` cell otherwise shows the display value of the related row when
 * the binding expands the relation (relationLabel.ts), and the record id as
 * before when it does not.
 */
export function cellLabel({ format, col, row, value }: LabelForCellArgs & { format?: string; row?: unknown }) {
    const mapped = labelForCell({ col, value });
    return format === 'relation' && mapped === value ? relationCellValue(value, row, col?.key) : mapped;
}
