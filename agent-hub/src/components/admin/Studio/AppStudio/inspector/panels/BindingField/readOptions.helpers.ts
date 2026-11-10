import type { FilterField } from '@/components/admin/Studio/AppStudio/bi/FilterRowsEditor.types';

/** The `search` of a records binding: the text (a formula or a literal) and the columns to look in. */
export interface BindingSearch {
    value?: string | { kind: string; expr?: string };
    fields?: string[];
}

/** Columns a text search can look in: text-like ones (and any column whose type is not known). */
const TEXT_TYPES = new Set(['text', 'long_text', 'email', 'url', 'phone', 'select']);

export function searchableFields(fields: FilterField[]): FilterField[] {
    return fields.filter((f) => !f.type || TEXT_TYPES.has(f.type));
}

/** The text of a search as the expression the input shows: a formula as it is, a literal quoted. */
export function searchExpr(search: BindingSearch): string {
    const v = search.value;
    if (v && typeof v === 'object') return v.expr ?? '';
    return typeof v === 'string' && v ? JSON.stringify(v) : '';
}

export function withSearchExpr(search: BindingSearch, expr: string): BindingSearch {
    return { ...search, value: { kind: 'formula', expr } };
}

/** The search with one column added or taken out; the last column stays (a search needs one). */
export function withSearchFields(search: BindingSearch, key: string, on: boolean): BindingSearch {
    const current = search.fields ?? [];
    const next = on ? [...current.filter((k) => k !== key), key] : current.filter((k) => k !== key);
    return next.length ? { ...search, fields: next } : search;
}
