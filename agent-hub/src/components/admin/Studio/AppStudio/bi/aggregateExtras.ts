import type { TableColumn } from '../inspector/aiFieldMatching';
import type { AppTable } from './useAppTables';
import type { DatasetGroup } from './useDatasets';

/**
 * The aggregate vocabulary after schema version 2, as the editors write it
 * (server: core/dataEngine/queryCompilerAggregateExt.mts):
 *   countDistinct            a measure: how many different values
 *   groupBy[].relatedField   break down by a field of the linked record
 *   groupBy[].binWidth       break a number down in whole-number steps
 *   groupFilter              keep only the groups whose number passes
 * Nothing here adds a key to a descriptor that does not use it.
 */

/** The comparisons a group filter offers, in the order the editor lists them. */
export const GROUP_FILTER_OPS = ['gte', 'gt', 'eq', 'neq', 'lt', 'lte'] as const;
export type GroupFilterOp = typeof GROUP_FILTER_OPS[number];

/** The measures that always yield a number; min/max only over a number field. */
const NUMERIC_AGGS = new Set(['count', 'countDistinct', 'sum', 'avg']);

/** The largest step the server accepts (core vocabulary AGGREGATE_LIMITS.MAX_BIN_WIDTH). */
const MAX_BIN_WIDTH = 1_000_000_000;

/** A group filter row in the editor: a measure by its position, so renaming it keeps the row. */
export interface GroupFilterRow {
    measure: number;
    op: GroupFilterOp;
    value: string;
}

type RelationColumn = TableColumn & { relation?: { table?: string } | null };

/** The fields of the table a relation field points at, or null when the field is no relation. */
export function relatedFieldsOf(tables: AppTable[], fields: TableColumn[], fieldKey: string | undefined): TableColumn[] | null {
    const field = fields.find((f) => f.key === fieldKey) as RelationColumn | undefined;
    if (!field || field.type !== 'relation') return null;
    const ref = field.relation?.table;
    const target = tables.find((tb) => tb.id === ref || tb.key === ref);
    return target && Array.isArray(target.fields) ? target.fields : [];
}

/** The type of what a breakdown groups on: the related field's when it goes through a relation. */
export function groupedType(tables: AppTable[], fields: TableColumn[], g: DatasetGroup): string | undefined {
    if (g.relatedField) return (relatedFieldsOf(tables, fields, g.field) || []).find((f) => f.key === g.relatedField)?.type;
    return fields.find((f) => f.key === g.field)?.type;
}

/** A typed step as the server takes it: a whole number from 1, or undefined (exact values). */
export function parseBinWidth(input: unknown): number | undefined {
    const n = typeof input === 'number' ? input : Number(String(input ?? '').trim());
    return Number.isInteger(n) && n >= 1 && n <= MAX_BIN_WIDTH ? n : undefined;
}

/**
 * The output column a breakdown produces, the way the compiler names it:
 * `as`, else <field>[_<relatedField>][_<bucket> | _bin].
 */
export function groupByColumnName(g: DatasetGroup | null | undefined): string | undefined {
    if (!g) return undefined;
    if (g.as) return g.as;
    if (!g.field) return undefined;
    const name = g.relatedField ? `${g.field}_${g.relatedField}` : g.field;
    const suffix = g.bucket ? `_${g.bucket}` : g.binWidth !== undefined && g.binWidth !== null ? '_bin' : '';
    return `${name}${suffix}`;
}

/** Whether a measure yields a number a group filter can compare. */
export function measureIsNumeric(agg: string, fieldType: string | undefined): boolean {
    return NUMERIC_AGGS.has(agg) || ((agg === 'min' || agg === 'max') && fieldType === 'number');
}

/** The group filter rows as the descriptor carries them; rows that are not complete yet are left out. */
export function groupFilterEntries(rows: GroupFilterRow[], aliases: (string | undefined)[]): { field: string; op: GroupFilterOp; value: number }[] {
    const out: { field: string; op: GroupFilterOp; value: number }[] = [];
    for (const r of rows) {
        const field = aliases[r.measure];
        const value = Number(String(r.value).trim().replace(',', '.'));
        if (field && String(r.value).trim() !== '' && Number.isFinite(value)) out.push({ field, op: r.op, value });
    }
    return out;
}

/**
 * One breakdown as the descriptor carries it: the field, then the related
 * field, then a date bucket (dates only) or a number step (numbers only).
 * A plain breakdown comes out as it always did: `{ field }` or `{ field, bucket }`.
 */
export function breakdownEntry(g: DatasetGroup, tables: AppTable[], fields: TableColumn[], isDate: (type: string | undefined) => boolean): DatasetGroup {
    const out: DatasetGroup = { field: g.field };
    if (g.relatedField && relatedFieldsOf(tables, fields, g.field)) out.relatedField = g.relatedField;
    const type = groupedType(tables, fields, out.relatedField ? g : { field: g.field });
    if (g.bucket && isDate(type)) out.bucket = g.bucket;
    else if (type === 'number') {
        const width = parseBinWidth(g.binWidth);
        if (width !== undefined) out.binWidth = width;
    }
    return out;
}
