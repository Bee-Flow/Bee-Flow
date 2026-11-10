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
 * Fields that travel only when the read carries them: how the filters join
 * (`match`) and a free search. A read without them builds the same descriptor
 * as before, so the SQL it compiles to does not change. The aggregate compiler
 * has no search group, so an aggregate takes `match` alone. A binding carries
 * them as marked binding keys (componentSpecs/keys/binding/); a caller that
 * resolves a search value itself passes the literal one in `own`.
 */
const RECORD_LIST_OPTIONAL_FIELDS = Object.freeze(['match', 'search']);
const AGGREGATE_OPTIONAL_FIELDS = Object.freeze(['match']);

function pick(src: Descriptor, fields: readonly string[], optional: readonly string[]): Descriptor {
    const out: Descriptor = {};
    for (const f of fields) out[f] = src[f];
    for (const f of optional) if (src[f] !== undefined && src[f] !== null) out[f] = src[f];
    return out;
}

/** The compileRecordList options for a read: the picked query fields, then the caller's own. */
export function recordListDescriptor(src: Descriptor, own: Descriptor = {}): Descriptor {
    return { ...pick(src, RECORD_LIST_FIELDS, RECORD_LIST_OPTIONAL_FIELDS), ...own };
}

/** The compileAggregate options for a read: the picked query fields, then the caller's own. */
export function aggregateDescriptor(src: Descriptor, own: Descriptor = {}): Descriptor {
    return { ...pick(src, AGGREGATE_FIELDS, AGGREGATE_OPTIONAL_FIELDS), ...own };
}
