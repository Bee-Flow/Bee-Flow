import { NO_VALUE_OPS, type FilterRow } from './FilterRowsEditor';
import type { FilterEntry } from './FilterRowsEditor.types';
import { isAnyGroupRow } from './FilterAnyGroup';
import { DATE_TYPES } from './QueryBuilderParts';
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

/** One filter clause as the compiler reads it. */
type Clause = { field: string; op: string; value?: unknown };

/** Build the structured aggregate descriptor compileAggregate consumes. */
export function buildDescriptor(
    tableId: string,
    fields: TableColumn[],
    groupBy: DatasetGroup[],
    aggregates: { agg: string; field?: string; label?: string }[],
    filters: FilterEntry[],
) {
    const fieldType = (key: string | undefined) => (fields.find((f) => f.key === key) || {}).type;
    const gb = (groupBy || [])
        .filter((g) => g.field)
        .map((g) => (g.bucket && DATE_TYPES.has(fieldType(g.field)) ? { field: g.field, bucket: g.bucket } : { field: g.field }));
    const usedAliases = new Set();
    const aggs = (aggregates || [])
        .filter((a) => a.agg && (a.agg === 'count' || a.field))
        .map((a) => {
            const isCount = a.agg === 'count';
            let alias = sanitizeAlias(a.label, isCount ? 'count' : `${a.agg}_${a.field || 'x'}`);
            let n = 2;
            while (usedAliases.has(alias)) alias = `${alias.slice(0, 58)}_${n++}`;
            usedAliases.add(alias);
            return { fn: a.agg, ...(isCount && !a.field ? {} : { field: a.field }), as: alias };
        });
    const clauseOf = (f: FilterRow): Clause => {
        const base = { field: f.field, op: f.op };
        if (NO_VALUE_OPS.has(f.op)) return base;
        let value = f.value;
        if (fieldType(f.field) === 'number' && typeof value !== 'boolean' && value !== '' && value != null) {
            const num = parseUserNumber(value);
            if (num != null) value = num;
        }
        return { ...base, value: value ?? '' };
    };
    const complete = (f: FilterRow) => !!(f.field && f.op);
    // An either/or group keeps its complete clauses; one left with none is dropped rather than saved empty.
    const flt = (filters || []).flatMap((entry): Array<Clause | { any: Clause[] }> => {
        if (!isAnyGroupRow(entry)) return complete(entry) ? [clauseOf(entry)] : [];
        const members = entry.any.filter(complete).map(clauseOf);
        return members.length ? [{ any: members }] : [];
    });

    // A row left pointing at a field the table doesn't have would compile to a
    // broken query server-side — name them so the user can repick, and block.
    const known = new Set<string | undefined>(fields.map((f) => f.key));
    const referenced = [...gb, ...aggs, ...flt.flatMap((x) => ('any' in x ? x.any : [x]))].map((x) => x.field).filter(Boolean);
    const unknownFields = [...new Set(referenced.filter((k) => !known.has(k)))];
    const base = { groupBy: gb, aggregates: aggs, filters: flt };
    return {
        descriptor: base,
        unknownFields,
        valid: !!tableId && (gb.length > 0 || aggs.length > 0) && unknownFields.length === 0,
    };
}

