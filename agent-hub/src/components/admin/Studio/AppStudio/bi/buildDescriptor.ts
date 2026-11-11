import { filterClauseFields } from '@shared/expr/filterGroups.mjs';
import { breakdownEntry, groupFilterEntries, type GroupFilterRow } from './aggregateExtras';
import { descriptorFilters } from './filterDescriptor';
import { NO_VALUE_OPS, type FilterRow } from './FilterRowsEditor';
import type { FilterEntry } from './FilterRowsEditor.types';
import { DATE_TYPES } from './QueryBuilderParts';
import type { AppTable } from './useAppTables';
import type { DatasetGroup } from './useDatasets';
import type { TableColumn } from '../inspector/aiFieldMatching';

/** The structured aggregate descriptor a dataset saves, built from the Query Builder's state. */

/**
 * Read a number the way people type it here: this is a Dutch product, so
 * "1.234,56" and "1,5" mean 1234.56 and 1.5. Returns null when it is not a
 * number at all (the value then travels on as text, as before).
 */
export function parseUserNumber(input: unknown) {
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    let s = String(input ?? '').replace(/\s/g, '');
    if (!s) return null;
    const comma = s.lastIndexOf(',');
    const dot = s.lastIndexOf('.');
    if (comma >= 0 && dot >= 0) {
        // The LAST separator is the decimal one; the other groups thousands.
        const thousands = comma > dot ? '.' : ',';
        s = s.split(thousands).join('');
        if (comma > dot) s = s.replace(',', '.');
    } else if (comma >= 0) {
        s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.split(',').join('') : s.replace(',', '.');
    }
    if (!/^-?(\d+\.?\d*|\.\d+)$/.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
}

/** Constrain a human label to the compiler's alias grammar (ALIAS_RE). */
function sanitizeAlias(label: string | undefined, fallback: string) {
    let s = String(label || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
    if (!s || !/^[a-z]/.test(s)) s = fallback;
    return s;
}

/** Build the structured aggregate descriptor compileAggregate consumes. */
export function buildDescriptor(
    tableId: string,
    fields: TableColumn[],
    groupBy: DatasetGroup[],
    aggregates: { agg: string; field?: string; label?: string }[],
    filters: FilterEntry[],
) {
    return buildQueryDescriptor({ tableId, fields, groupBy, aggregates, filters });
}

interface QueryParts {
    tableId: string;
    fields: TableColumn[];
    groupBy: DatasetGroup[];
    aggregates: { agg: string; field?: string; label?: string }[];
    filters: FilterEntry[];
    /** Resolves breakdowns through a relation. */
    tables?: AppTable[];
    /** Rows that name a measure by its position in `aggregates`. */
    groupFilter?: GroupFilterRow[];
}

/** buildDescriptor, with the breakdowns through a relation and the group filter. */
export function buildQueryDescriptor({ tableId, fields, groupBy, aggregates, filters, ...extra }: QueryParts) {
    const fieldType = (key: string | undefined) => (fields.find((f) => f.key === key) || {}).type;
    const gb = (groupBy || [])
        .filter((g) => g.field)
        .map((g) => breakdownEntry(g, extra.tables || [], fields, (type) => DATE_TYPES.has(type)));
    const usedAliases = new Set();
    const aliasAt: (string | undefined)[] = [];
    const aggs = (aggregates || [])
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => a.agg && (a.agg === 'count' || a.field))
        .map(({ a, i }) => {
            const isCount = a.agg === 'count';
            let alias = sanitizeAlias(a.label, isCount ? 'count' : `${a.agg}_${a.field || 'x'}`);
            let n = 2;
            while (usedAliases.has(alias)) alias = `${alias.slice(0, 58)}_${n++}`;
            usedAliases.add(alias);
            aliasAt[i] = alias;
            return { fn: a.agg, ...(isCount && !a.field ? {} : { field: a.field }), as: alias };
        });
    const gf = groupFilterEntries(extra.groupFilter || [], aliasAt);
    const leaf = (f: FilterRow) => {
        const base = { field: f.field, op: f.op };
        if (NO_VALUE_OPS.has(f.op)) return base;
        if (typeof f.otherField === 'string') return { ...base, otherField: f.otherField };
        let value = f.value;
        if (fieldType(f.field) === 'number' && typeof value !== 'boolean' && value !== '' && value != null) {
            const num = parseUserNumber(value);
            if (num != null) value = num;
        }
        return { ...base, value: value ?? '' };
    };
    // A group keeps its complete clauses; one left with none is dropped rather than saved empty.
    const flt = descriptorFilters(filters || [], leaf);

    // A row left pointing at a field the table doesn't have would compile to a
    // broken query server-side — name them so the user can repick, and block.
    const known = new Set<string | undefined>(fields.map((f) => f.key));
    const referenced = [...[...gb, ...aggs].map((x) => x.field), ...filterClauseFields(flt)].filter(Boolean);
    const unknownFields = [...new Set(referenced.filter((k) => !known.has(k)))];
    return {
        descriptor: { groupBy: gb, aggregates: aggs, filters: flt, ...(gf.length ? { groupFilter: gf } : {}) },
        unknownFields,
        valid: !!tableId && (gb.length > 0 || aggs.length > 0) && unknownFields.length === 0,
    };
}
