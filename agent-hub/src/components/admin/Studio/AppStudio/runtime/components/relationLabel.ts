/**
 * What a `relation` cell shows when its binding expands the relation
 * (`expand: [{ field, pick?, as? }]` on a record / records binding).
 *
 * The server puts the related row on each record under the entry's `as`, or
 * `<relation field>_record` when it names none, as `{ id, ...picked }` plus
 * `_label`: the value of the relation's display field
 * (data model `relation.displayField`), when the model names one. A related row
 * the viewer may not read is null there. The names are the server's
 * (core/dataEngine/dataModel/vocabulary.js EXPAND_DEFAULT_SUFFIX and
 * EXPAND_LABEL_KEY; relationLabel.test.ts holds them together).
 *
 * A column on the relation field itself (`key: 'customer'`) therefore shows the
 * display value instead of the bare record id, and a column on the expansion
 * (`key: 'customer_record'`) shows the same. Without an expansion on the row
 * the value is returned untouched, so a table that never asked for one renders
 * as it always did.
 */

export const EXPAND_DEFAULT_SUFFIX = '_record';
export const EXPAND_LABEL_KEY = '_label';

type Row = Record<string, unknown>;

const isRow = (v: unknown): v is Row => v !== null && typeof v === 'object' && !Array.isArray(v);
const filled = (v: unknown): boolean => v !== undefined && v !== null && v !== '';

/** The display value of an expanded row: its `_label`, else its id. */
function labelOf(expanded: Row): unknown {
    return filled(expanded[EXPAND_LABEL_KEY]) ? expanded[EXPAND_LABEL_KEY] : expanded.id ?? null;
}

/**
 * @param value  the cell's own value: a record id, or the expanded row itself
 * @param row    the record the cell belongs to
 * @param key    the column's key
 */
export function relationCellValue(value: unknown, row: unknown, key: unknown): unknown {
    if (isRow(value)) return labelOf(value);
    if (!isRow(row) || typeof key !== 'string' || !key) return value;
    const expanded = row[`${key}${EXPAND_DEFAULT_SUFFIX}`];
    return isRow(expanded) && filled(expanded[EXPAND_LABEL_KEY]) ? expanded[EXPAND_LABEL_KEY] : value;
}
