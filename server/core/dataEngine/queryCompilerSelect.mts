/**
 * The select list of a record read: which columns a list or a get-by-id
 * returns.
 *
 * Every column of the one table (`*`) unless the read names its columns
 * (`fields`, queryCompilerRelation.resolveFields): then those columns, each
 * once, in the order given. A read that asks for it (`readTimeComputed: true`)
 * also gets each read-time computed field as an expression after those columns
 * (queryCompilerComputed.mts); a table without one, or a read that does not
 * ask, compiles to the columns alone exactly as before. It lives in its own
 * module so a change to what a read returns is made here once, for
 * compileRecordList and compileGetById together, instead of in each compiler.
 */

import { readTimeComputedSelect } from './queryCompilerComputed.mts';
import type { ComputedSelect } from './queryCompilerComputed.mts';

type TableMeta = Parameters<typeof readTimeComputedSelect>[0];

/** The read-time computed part of a read, or null when the read does not have one. */
export function computedSelectFor(tableMeta: TableMeta, opts: { readTimeComputed?: unknown } | undefined, dialect: string): ComputedSelect | null {
    if (!opts || opts.readTimeComputed !== true) return null;
    return readTimeComputedSelect(tableMeta, dialect);
}

/**
 * The select list of compileRecordList and compileGetById.
 * @param columns   quoted column names, or nothing for every column
 * @param computed  the read-time computed part, or null
 * @param fallback  true for the list with every computed field NULL
 */
export function recordSelectList(columns?: readonly string[] | null, computed: ComputedSelect | null = null, fallback = false): string {
    const base = !columns || columns.length === 0 ? '*' : columns.filter((c, i) => columns.indexOf(c) === i).join(', ');
    if (!computed) return base;
    // Both computed lists start with `*`: the read's own columns take its place.
    const list = fallback ? computed.fallbackList : computed.list;
    return base === '*' ? list : `${base}${list.slice(1)}`;
}

/**
 * What a compiled read carries next to its SQL when it has read-time computed
 * fields: the same read with every one of them NULL (same params), for the
 * caller to fall back on when an expression fails on the engine.
 */
export function computedReadMeta(computed: ComputedSelect | null, sqlWith: (list: string) => string, columns?: readonly string[] | null): Record<string, unknown> {
    if (!computed) return {};
    return {
        readTimeComputed: {
            keys: computed.keys,
            refused: computed.refused,
            columns: computed.columns,
            fallbackSql: sqlWith(recordSelectList(columns, computed, true)),
        },
    };
}
