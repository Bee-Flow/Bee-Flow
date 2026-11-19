/**
 * A table handle where a step expects a list: the rows of the stored table.
 *
 * read_table and table hand a HANDLE on, and carry the rows inline only when
 * the table is small (AUTOMATION_TABLE_INLINE_ROWS). A Loop over
 * `steps.<id>.output.table` (with a batch size: n rows per pass, one tool call
 * per batch) needs the rows of a table of any size; this reads them, through
 * the table store's own authorisation (a table of another run is not found),
 * at most `cap` rows.
 *
 * Anything that is not a handle (or `{ table: handle }`) is returned as it
 * came, so a list keeps working exactly as before.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Opened = { rows: () => AsyncIterable<Row> | Iterable<Row> } | null;
export interface HandleRowsDeps {
    isTableHandle: (v: unknown) => boolean;
    openTable: (handle: unknown, scope: Record<string, unknown>) => Promise<Opened>;
}

/** The collaborators; a test may replace them (the table store it runs against). */
export const handleRowsDeps: HandleRowsDeps = {
    isTableHandle: (v) => nodeRequire('./handle').isTableHandle(v),
    openTable: (h, scope) => nodeRequire('./tableStore').openTable(h, scope),
};

export interface RunScope { runId?: string; rootRunId?: string; automationId?: string; userId?: string }

function stepError(errorClass: string, message: string): Error {
    return Object.assign(new Error(message), { errorClass });
}

/** The handle a value is, or carries as `.table`; null otherwise. */
export function tableHandleOf(value: unknown, deps: HandleRowsDeps = handleRowsDeps): { tableId: string; preview?: Row[] } | null {
    if (deps.isTableHandle(value)) return value as { tableId: string };
    const inner = value && typeof value === 'object' && !Array.isArray(value) ? (value as { table?: unknown }).table : undefined;
    return deps.isTableHandle(inner) ? inner as { tableId: string } : null;
}

/**
 * `value`, or the rows of the table it is a handle of. A dry-run handle (no
 * stored table) gives its preview, which is empty.
 */
export async function rowsOfTableValue(value: unknown, ctx: RunScope, cap: number, deps: HandleRowsDeps = handleRowsDeps): Promise<unknown> {
    const handle = tableHandleOf(value, deps);
    if (!handle) return value;
    if (handle.tableId === 'dry-run') return Array.isArray(handle.preview) ? handle.preview : [];
    const opened = await deps.openTable(handle, { runId: ctx.runId, rootRunId: ctx.rootRunId, automationId: ctx.automationId, userId: ctx.userId });
    if (!opened) throw stepError('table_not_found', 'The table from an earlier step has expired or belongs to another run. Run the step that makes it again.');
    const rows: Row[] = [];
    for await (const row of opened.rows()) {
        if (cap > 0 && rows.length >= cap) {
            throw stepError('collection_too_large', `The table has more than ${cap} rows to loop over. Filter it first, or raise AUTOMATION_COLLECTION_MAX_ITEMS.`);
        }
        rows.push(row);
    }
    return rows;
}
