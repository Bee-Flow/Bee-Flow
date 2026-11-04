/**
 * App Studio action executor: the ONE idempotent writeTo (package 5).
 *
 * ai_extract, file_intake and dataset_query all write their rows through `writeTo`. Each used to
 * carry its own upsert loop on one column; this module is the shared form:
 *
 *   writeTo.upsertKey: [col, ...] (1..5)  a row whose key columns equal an existing row's is an
 *                                         UPDATE of that row, not a second copy. Exactly the
 *                                         listed columns, nothing implicit.
 *   writeTo.upsertOn: col (legacy)        [col] plus the scalar, non-date constants (two orders
 *                                         never collide on the same part number).
 *   writeTo.replaceWhere: [clause, ...]   delete the rows it matches first, then write. Strict
 *                                         (an empty value refuses), under the DELETE access
 *                                         filter, at most LIMITS.MAX_BULK_WRITE_ROWS or refused
 *                                         with nothing changed.
 *
 * Atomicity: a plain insert with replaceWhere is ONE batch (replaceRecords.mts). With a key
 * the replace runs first and the rows are upserted one by one: not atomic, documented in the guide.
 * A row with an empty key value has no identity: it is inserted (or reported as unmatched with
 * insertMissing:false), never matched against the row whose key happens to be empty too.
 */

import { createRequire } from 'node:module';
import { resolveWriteTarget, resolveStrictFilters, countMatching, WriteFilterError } from './writeTarget.mts';
import type { Filter } from './writeTarget.mts';
import { eraseMatching } from './bulkRecords.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type Table = Obj & { key: string; id?: string; fields?: Obj[] };
type WriteRecord = (app: App, model: unknown, table: Table, values: Obj, o: Obj) => Promise<Obj>;

const { LIMITS } = nodeRequire('../componentSpecs/limits') as { LIMITS: Record<string, number> };

export type UpsertKey = { columns: string[]; narrowBy: [string, unknown][] };
export type RunCtx = { ctx: Obj; resolveValue: (b: unknown) => unknown; viewer: Obj };

const isEmpty = (v: unknown): boolean => v === null || v === undefined || v === '';
const isScalar = (v: unknown): boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function fieldOf(table: Table, col: string): Obj | undefined {
    return (Array.isArray(table.fields) ? table.fields : []).find((f) => f && f.key === col);
}

/** The scalar, non-date constants: identity for the legacy key, a date `now` is a stamp. */
function identifyingConstants(table: Table, constants: Obj): [string, unknown][] {
    return Object.entries(constants || {}).filter(([col, v]) => {
        const field = fieldOf(table, col);
        if (field && (field.type === 'date' || field.type === 'datetime')) return false;
        return isScalar(v);
    });
}

/**
 * Which columns identify a row. `implicit` is file_intake's base_name column (used when no
 * upsertKey is set, narrowed by the constants as before); dataset_query passes `narrow:false`.
 */
export function upsertKeyOf(writeTo: Obj, table: Table, constants: Obj, opts: { implicit?: string | null; narrow?: boolean } = {}): UpsertKey | null {
    const key = writeTo.upsertKey;
    if (Array.isArray(key) && key.length) {
        const columns = key.filter((c): c is string => typeof c === 'string' && !!c && !!fieldOf(table, c)).slice(0, LIMITS.MAX_UPSERT_KEY_COLUMNS);
        return columns.length ? { columns, narrowBy: [] } : null;
    }
    const legacy = typeof writeTo.upsertOn === 'string' && writeTo.upsertOn ? writeTo.upsertOn : (opts.implicit || null);
    if (!legacy) return null;
    return { columns: [legacy], narrowBy: opts.narrow === false ? [] : identifyingConstants(table, constants) };
}

/** The equality clauses that find this row's twin, or null when a key value is empty (no identity). */
export function keyFilterOf(key: UpsertKey, values: Obj): (Filter & { required: boolean })[] | null {
    const out: (Filter & { required: boolean })[] = [];
    for (const col of key.columns) {
        if (isEmpty(values[col])) return null;
        out.push({ field: col, op: 'eq', value: values[col], required: true });
    }
    for (const [col, v] of key.narrowBy) out.push({ field: col, op: 'eq', value: v, required: false });
    return out;
}

/** The existing row with this key, read as the viewer (the same lookup the steps always used). */
export async function findExistingByKey(app: App, model: unknown, table: Table, filter: Filter[], run: RunCtx): Promise<Obj | null> {
    const stepDataSource = nodeRequire('../stepDataSource') as { resolveDataBinding(a: App, m: unknown, b: Obj, o: Obj): Promise<Obj | null> };
    const found = await stepDataSource.resolveDataBinding(app, model, { kind: 'record', tableId: table.id, filter }, {
        viewer: run.viewer, role: run.ctx.role ?? null, resolveValue: run.resolveValue,
    });
    return found && typeof found === 'object' ? found : null;
}

/** fillOnly: only columns that are still empty on the existing row; constants always (provenance). */
function fillOnlyValues(values: Obj, existing: Obj, constantCols: Set<string>): Obj {
    const out: Obj = {};
    for (const [col, v] of Object.entries(values)) {
        if (constantCols.has(col)) out[col] = v;
        else if (!isEmpty(v) && isEmpty(existing[col])) out[col] = v;
    }
    return out;
}

export type UpsertOpts = {
    key: UpsertKey; constants: Obj; run: RunCtx; writeRecord: WriteRecord; writeViewer: Obj;
    insertMissing?: boolean; fillOnly?: boolean;
};

/**
 * Write `rows` one by one: an existing row with the same key is updated, a new key inserted. In
 * order, so a duplicate key inside one batch updates the row written a moment earlier.
 * Returns `{ written, unmatched, ids }` (ids per input row, null for an unmatched one).
 */
export async function upsertRows(app: App, model: unknown, table: Table, rows: Obj[], o: UpsertOpts): Promise<{ written: number; unmatched: string[]; ids: (string | null)[] }> {
    const constantCols = new Set(Object.keys(o.constants || {}));
    let written = 0;
    const unmatched: string[] = [];
    const ids: (string | null)[] = [];
    for (const values of rows) {
        const filter = keyFilterOf(o.key, values);
        const existing = filter ? await findExistingByKey(app, model, table, filter, o.run) : null;
        if (!existing && o.insertMissing === false) {
            unmatched.push(o.key.columns.map((c) => (values[c] == null ? '' : String(values[c]))).join(' / '));
            ids.push(null);
            continue;
        }
        const toWrite = o.fillOnly && existing ? fillOnlyValues(values, existing, constantCols) : values;
        const saved = await o.writeRecord(app, model, table, toWrite, {
            viewer: o.writeViewer, recordId: existing && existing.id ? existing.id : undefined,
        });
        ids.push(String((saved && saved.id) || (existing && existing.id) || '') || null);
        written += 1;
    }
    return { written, unmatched, ids };
}

/** A replaceWhere that cannot run: the step ends with this, nothing changed. */
export type ReplaceRefusal = { ok: false; error: string; code: string; retryable: false };

const refuse = (error: string, code: string): ReplaceRefusal => ({ ok: false, error, code, retryable: false });

/** The viewer a write runs as: the run's viewer with the resolved role (actionExecutor/shared.writeViewer). */
const writerOf = (run: RunCtx): Obj => (run.viewer.role === undefined ? { ...run.viewer, role: run.ctx.role ?? null } : run.viewer);

/**
 * Resolve and check `replaceWhere` before anything is written: strict values, the DELETE scope,
 * the count under the limit. Returns the literal filters, or the refusal.
 */
export async function prepareReplace(app: App, table: Table, replaceWhere: unknown, run: RunCtx): Promise<{ filters: Filter[]; matched: number } | ReplaceRefusal> {
    const limit = LIMITS.MAX_BULK_WRITE_ROWS;
    let strict;
    try {
        strict = resolveStrictFilters(replaceWhere, run.resolveValue);
    } catch (e) {
        if (e instanceof WriteFilterError) return refuse(`replaceWhere: ${e.message}`, e.code === 'bulk_filter_empty' ? 'replace_filter_empty' : e.code);
        throw e;
    }
    if (strict.blocked) {
        return refuse(`replaceWhere: the filter value for "${strict.field}" was empty, so nothing was replaced or written.`, 'replace_filter_empty');
    }
    const target = await resolveWriteTarget(app, table, writerOf(run), 'delete');
    if (target.kind === 'mirror') return refuse('replaceWhere cannot run on a table that mirrors an external source.', 'replace_on_mirror');
    const matched = await countMatching(target, strict.filters);
    if (matched > limit) {
        return refuse(`replaceWhere matches ${matched} rows; at most ${limit} can be replaced in one step (limit ${limit}). Narrow replaceWhere.`, 'replace_limit_exceeded');
    }
    return { filters: strict.filters, matched };
}

/** Delete the replaceWhere rows now (the key path: delete first, then upsert row by row). */
export async function replaceBefore(app: App, table: Table, filters: Filter[], run: RunCtx): Promise<number> {
    const target = await resolveWriteTarget(app, table, writerOf(run), 'delete');
    const out = await eraseMatching(target, filters, LIMITS.MAX_BULK_WRITE_ROWS);
    return out.changed;
}

export const isRefusal = (v: unknown): v is ReplaceRefusal => !!v && typeof v === 'object' && (v as Obj).ok === false;
