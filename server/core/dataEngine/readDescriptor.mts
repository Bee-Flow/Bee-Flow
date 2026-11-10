/**
 * The read descriptor: which fields of a read request travel on to the query
 * compiler.
 *
 * Every App Studio read entry point (the shared read runner behind the data
 * routes and the batch, server-step data sources, saved datasets, the dry run,
 * the server-side render) builds the options for compileRecordList or
 * compileAggregate from what the author or the client sent. They used to copy
 * the field names one by one, each its own list, so a field one of them passed
 * on was silently dropped by another. The lists live here now: a descriptor
 * field the compiler learns is added once, below, and reaches every caller.
 *
 * What stays with the caller is what is the caller's to decide: the page
 * (`cursor`, `limit` and its caps), the dialect of the storage it reads, and
 * values it resolved itself (a step resolves bound filter values first). Those
 * go in `own`, which wins over the picked fields.
 *
 * Pure: no compiler call, no validation. The compiler validates every field.
 */

type Descriptor = Record<string, unknown>;

/** The query-shape fields of a record list, in the order they are passed on. */
const RECORD_LIST_FIELDS = Object.freeze(['filters', 'sort']);

/** The query-shape fields of an aggregate, in the order they are passed on. */
const AGGREGATE_FIELDS = Object.freeze(['filters', 'groupBy', 'aggregates', 'sort']);

/**
 * Fields that travel only when the request carries them (how the filters are
 * combined, a free search). A read without them builds the same descriptor as
 * before, so the SQL it compiles to does not change. The aggregate compiler
 * has no search group, so an aggregate takes `match` alone.
 */
const RECORD_LIST_OPTIONAL_FIELDS = Object.freeze(['match', 'search']);
const AGGREGATE_OPTIONAL_FIELDS = Object.freeze(['match']);

function pick(src: Descriptor, fields: readonly string[], optional: readonly string[] = []): Descriptor {
    const out: Descriptor = {};
    for (const f of fields) out[f] = src[f];
    for (const f of optional) if (src[f] !== undefined && src[f] !== null) out[f] = src[f];
    return out;
}

type ResolveValue = (binding: Record<string, unknown>) => unknown;

/**
 * The `search` of a binding with its value made literal: the compiler wants a
 * non-empty string, a binding may carry a formula (a search box). Anything that
 * does not resolve to text (nothing typed yet, a number is spelled out) leaves
 * the search out, as an unset filter value is left out. Pure; the caller says
 * how a bound value resolves.
 */
export function resolveSearch(search: unknown, resolveValue?: ResolveValue): Descriptor | null {
    if (!search || typeof search !== 'object' || Array.isArray(search)) return null;
    const spec = search as Descriptor;
    let value = spec.value;
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof (value as Descriptor).kind === 'string') {
        value = resolveValue ? resolveValue(value as Record<string, unknown>) : undefined;
    }
    if (typeof value === 'number' && Number.isFinite(value)) value = String(value);
    if (typeof value !== 'string' || value.trim() === '') return null;
    return { value, fields: spec.fields };
}

/** The compileRecordList options for a read: the picked query fields, then the caller's own. */
export function recordListDescriptor(src: Descriptor, own: Descriptor = {}): Descriptor {
    return { ...pick(src, RECORD_LIST_FIELDS, RECORD_LIST_OPTIONAL_FIELDS), ...own };
}

/** The compileAggregate options for a read: the picked query fields, then the caller's own. */
export function aggregateDescriptor(src: Descriptor, own: Descriptor = {}): Descriptor {
    return { ...pick(src, AGGREGATE_FIELDS, AGGREGATE_OPTIONAL_FIELDS), ...own };
}
