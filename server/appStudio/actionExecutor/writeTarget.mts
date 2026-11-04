/**
 * App Studio action executor: WHERE a filter-scoped write lands and WHICH rows it may touch.
 *
 * One resolution for the three storage kinds a model table can have, so the bulk update/delete
 * steps (bulkRecords.mts) and writeTo.replaceWhere (writeToRows.mts) never each grow their own:
 *   - 'app'       the app's own storage: assertCanWrite for the op, then the access filter of the
 *                 SAME op ('update' / 'delete'), never the read scope.
 *   - 'datatable' a linked Studio datatable: datatableSource.resolveDatatableWrite decides the
 *                 grade (and refuses a read-only link, `safe`), the access filter is compiled on
 *                 that grade, the store is datatableDbStore on the scope key, Postgres dialect.
 *   - 'mirror'    a datatable that mirrors an external source: rows are matched on the local
 *                 copy and written one by one through the source (not atomic, documented).
 *
 * `resolveStrictFilters` is the write side of a filter: an empty value BLOCKS the write instead of
 * being dropped (dropping it would widen "rows of this order" to "every row"). Package 6 moves it
 * onto filterGroups.resolveFilterList with a strict option (PLAN decision 13).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
export type Filter = { field?: string; op?: string; value?: unknown; ci?: boolean };
type App = { id: string; userId: string; organizationId?: string | null };
type AccessFilter = { where: string; params: unknown[] };
type Compiled = { sql: string; params: unknown[] };
type ExecResult = { changes?: number } | null | undefined;
type Op = 'update' | 'delete';

export type WriteTarget = {
    kind: 'app' | 'datatable' | 'mirror';
    table: Obj & { key: string };
    tableMeta: Obj & { key: string };
    dialect: string | undefined;
    access: AccessFilter;
    query(sql: string, params: unknown[]): Promise<Obj[]>;
    exec(sql: string, params: unknown[]): Promise<number>;
    batch(statements: Compiled[]): Promise<unknown>;
    /** Data version + row count after a committed write (best effort). */
    bump(delta: number): Promise<void>;
    bound: Obj | null;
};

const rls = nodeRequire('../rlsGateway') as {
    assertCanWrite(t: unknown, role: unknown, op: string): void;
    compileAccessFilter(t: unknown, role: unknown, viewer: unknown, op: string, o?: Obj): AccessFilter;
};
const datatableSource = nodeRequire('../datatableSource') as {
    isDatatableBacked(t: unknown): boolean;
    resolveDatatableWrite(ctx: Obj, t: unknown, op: string): Promise<Obj>;
};
const records = nodeRequire('./records') as {
    bumpVersion(app: App, key: string): Promise<void>;
    bumpCount(app: App, key: string, delta: number): Promise<void>;
    bumpDatatable(bound: Obj, delta: number): Promise<void>;
    isSourceMirror(bound: Obj): boolean;
};
const bulk = nodeRequire('../../core/dataEngine/queryCompilerBulk.mts') as {
    compileMatchIds(t: unknown, f: Filter[], a: AccessFilter, o: Obj): Compiled & { limit: number };
    compileCountMatching(t: unknown, f: Filter[], a: AccessFilter, o: Obj): Compiled;
};

function appStore(): { query(o: string, a: string, sql: string, p: unknown[]): Promise<{ rows?: Obj[] }>; exec(o: string, a: string, sql: string, p: unknown[]): Promise<ExecResult>; batch(o: string, a: string, s: Compiled[]): Promise<unknown> } {
    return nodeRequire('../../stores/studioAppDbStore');
}
function dtStore(): ReturnType<typeof appStore> {
    return nodeRequire('../../stores/datatableDbStore');
}

const changesOf = (r: ExecResult): number => Number(r && r.changes) || 0;

/** The app's own storage, under the access filter of `op`. */
function appTarget(app: App, table: Obj & { key: string }, viewer: Obj, op: Op): WriteTarget {
    const role = viewer.role ?? null;
    rls.assertCanWrite(table, role, op);
    const access = rls.compileAccessFilter(table, role, viewer, op);
    const s = appStore();
    return {
        kind: 'app', table, tableMeta: table, dialect: undefined, access, bound: null,
        query: async (sql, params) => (await s.query(app.userId, app.id, sql, params))?.rows ?? [],
        exec: async (sql, params) => changesOf(await s.exec(app.userId, app.id, sql, params)),
        batch: (statements) => s.batch(app.userId, app.id, statements),
        bump: async (delta) => {
            await records.bumpVersion(app, table.key);
            if (delta) await records.bumpCount(app, table.key, delta);
        },
    };
}

/** A linked datatable (or a source mirror), on the grade resolveDatatableWrite decided. */
async function datatableTarget(app: App, table: Obj & { key: string }, viewer: Obj, op: Op): Promise<WriteTarget> {
    const bound = await datatableSource.resolveDatatableWrite(
        { app, viewerId: viewer.id ?? null, role: viewer.role ?? null, viewer }, table, op);
    const dialect = bound.dialect as string | undefined;
    const tableMeta = bound.tableMeta as Obj & { key: string };
    const access = rls.compileAccessFilter(tableMeta, bound.grade, bound.viewer, op, { dialect });
    const s = dtStore();
    const key = bound.scopeKey as string;
    return {
        kind: records.isSourceMirror(bound) ? 'mirror' : 'datatable', table, tableMeta, dialect, access, bound,
        query: async (sql, params) => (await s.query(key, key, sql, params))?.rows ?? [],
        exec: async (sql, params) => changesOf(await s.exec(key, key, sql, params)),
        batch: (statements) => s.batch(key, key, statements),
        bump: (delta) => records.bumpDatatable(bound, delta),
    };
}

/** Where a filter-scoped `op` on `table` lands for this viewer. Throws the access/source refusals. */
export async function resolveWriteTarget(app: App, table: Obj & { key: string }, viewer: Obj | null | undefined, op: Op): Promise<WriteTarget> {
    const v = viewer && typeof viewer === 'object' ? viewer : {};
    if (datatableSource.isDatatableBacked(table)) return datatableTarget(app, table, v, op);
    return appTarget(app, table, v, op);
}

/** A refusal the step returns as its result: an HTTP-ish status, a code, a sentence. */
export class WriteFilterError extends Error {
    status: number;
    code: string;
    safe = true;
    constructor(message: string, code: string, status = 422) {
        super(message);
        this.code = code;
        this.status = status;
    }
}

const VALUELESS_OPS = new Set(['isNull', 'isNotNull']);
const isBinding = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v) && typeof (v as Obj).kind === 'string';

/**
 * The authored clause list → literal clauses, STRICTLY: a clause whose value resolves to nothing
 * blocks the whole write (`{ blocked: true, field }`) rather than being dropped. Valueless ops are
 * kept as they are; an empty array stays (`in []` matches nothing). A formula STRING instead of a
 * list cannot be compiled on the server and is refused.
 */
export function resolveStrictFilters(filters: unknown, resolveValue: (b: unknown) => unknown): { filters: Filter[]; blocked: false } | { filters: []; blocked: true; field: string } {
    if (typeof filters === 'string') {
        throw new WriteFilterError('A formula-string filter cannot run on the server: write the filter as a list of { field, op, value } clauses.', 'filter_invalid');
    }
    if (!Array.isArray(filters)) throw new WriteFilterError('A write filter must be a list of { field, op, value } clauses.', 'filter_invalid');
    // No clause at all would mean every row: never the reading of an empty filter.
    if (!filters.length) throw new WriteFilterError('A write filter needs at least one clause; an empty filter would change every row.', 'bulk_filter_empty');
    const out: Filter[] = [];
    for (const entry of filters) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new WriteFilterError('Each write filter clause must be an object { field, op, value }.', 'filter_invalid');
        const { required: _required, value: raw, ...rest } = entry as Obj & Filter & { required?: unknown };
        if (typeof rest.op === 'string' && VALUELESS_OPS.has(rest.op)) { out.push(rest); continue; }
        const value = isBinding(raw) ? resolveValue(raw) : raw;
        if (value === undefined || value === null || value === '') {
            return { filters: [], blocked: true, field: typeof rest.field === 'string' ? rest.field : '' };
        }
        out.push({ ...rest, value });
    }
    return { filters: out, blocked: false };
}

/** A compile error of the author's filter is the author's to fix: a 422 with the compiler's sentence. */
function asFilterError(e: unknown): never {
    const err = e as { name?: string; message?: string };
    if (err && err.name === 'CompileError') throw new WriteFilterError(`The filter cannot run: ${err.message}.`, 'filter_invalid');
    throw e;
}

/** How many rows the filter matches under the write scope, and the ids of the first `limit` (oldest first). */
export async function matchIds(target: WriteTarget, filters: Filter[], limit: number): Promise<{ matched: number; ids: string[] }> {
    let count: Compiled;
    let pick: Compiled;
    try {
        count = bulk.compileCountMatching(target.tableMeta, filters, target.access, { dialect: target.dialect });
        pick = bulk.compileMatchIds(target.tableMeta, filters, target.access, { dialect: target.dialect, limit });
    } catch (e) { asFilterError(e); }
    const [countRow] = await target.query(count.sql, count.params);
    const matched = Number(countRow && (countRow.n ?? Object.values(countRow)[0])) || 0;
    if (!matched) return { matched: 0, ids: [] };
    const rows = await target.query(pick.sql, pick.params);
    return { matched, ids: rows.map((r) => String(r.id)).filter(Boolean) };
}

/** Only the number of matching rows (a replaceWhere precheck, a dry-run preview). */
export async function countMatching(target: WriteTarget, filters: Filter[]): Promise<number> {
    let count: Compiled;
    try {
        count = bulk.compileCountMatching(target.tableMeta, filters, target.access, { dialect: target.dialect });
    } catch (e) { asFilterError(e); }
    const [row] = await target.query(count.sql, count.params);
    return Number(row && (row.n ?? Object.values(row)[0])) || 0;
}
