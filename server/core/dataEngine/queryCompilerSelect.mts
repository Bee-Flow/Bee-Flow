/**
 * The select list of a record read: which columns a list or a get-by-id
 * returns.
 *
 * Every column of the one table (`*`). A read that asks for it
 * (`readTimeComputed: true`) also gets each read-time computed field as an
 * expression after the `*` (queryCompilerComputed.mts); a table without one,
 * or a read that does not ask, compiles to `*` exactly as before. It lives in
 * its own module so a change to what a read returns is made here once, for
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

/** The select list of compileRecordList and compileGetById. */
export function recordSelectList(computed: ComputedSelect | null = null): string {
    return computed ? computed.list : '*';
}

/**
 * What a compiled read carries next to its SQL when it has read-time computed
 * fields: the same read with every one of them NULL (same params), for the
 * caller to fall back on when an expression fails on the engine.
 */
export function computedReadMeta(computed: ComputedSelect | null, sqlWith: (list: string) => string): Record<string, unknown> {
    if (!computed) return {};
    return {
        readTimeComputed: {
            keys: computed.keys,
            refused: computed.refused,
            columns: computed.columns,
            fallbackSql: sqlWith(computed.fallbackList),
        },
    };
}
