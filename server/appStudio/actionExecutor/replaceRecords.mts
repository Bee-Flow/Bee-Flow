/**
 * App Studio action executor: writeTo.replaceWhere on the plain-insert path (package 5, moved
 * out of records.js). DELETE the rows matching `filters` (already resolved strictly by
 * writeTarget.resolveStrictFilters, at most `limit` of them, under the DELETE access filter) and
 * INSERT `rows`, in ONE batch: either the old set is replaced or nothing changed. The caller has
 * already counted the matches and refused past the limit.
 *
 * Returns `{ ids, deleted }`. A source mirror is refused (`safe`, 422): its rows live in the
 * source and cannot be replaced together with the inserts.
 */

import { createRequire } from 'node:module';
import type { Filter } from './writeTarget.mts';
import { applyFieldRulesToRows } from '../../core/dataEngine/fieldRules.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type Table = Obj & { key: string };
type Statement = { sql: string; params: unknown[] };
type Viewer = Obj & { id?: string | null; role?: string | null };
type Bound = {
    tableMeta: Obj; grade: unknown; viewer: Viewer; dialect: string; scope: unknown; scopeKey: string;
    datatable: Obj & { id: string; organizationId?: string | null };
};
type BatchResult = { changes?: number }[] | null | undefined;
export type ReplaceOpts = { viewer?: unknown; filters: Filter[]; limit: number };

const records = nodeRequire('./records') as {
    compileInserts(t: unknown, rows: Obj[], o: { createdBy: unknown; orgId: unknown; dialect?: string }): { statements: Statement[]; ids: string[] };
    resolveWrite(app: App, table: Table, viewer: unknown, action: 'create' | 'delete'): Promise<Bound>;
    dtStore(): { batch(a: string, b: string, s: Statement[]): Promise<BatchResult> };
    isSourceMirror(bound: Bound): boolean;
};
const { bumpVersion, bumpCount, bumpDatatable } = nodeRequire('./bookkeeping.mts') as typeof import('./bookkeeping.mts');
const queryCompiler = nodeRequire('../queryCompiler') as { assertRowsWritable(t: unknown): void };
const rlsGateway = nodeRequire('../rlsGateway') as {
    assertCanWrite(t: unknown, role: unknown, op: string): void;
    compileAccessFilter(t: unknown, role: unknown, viewer: unknown, op: string, o?: Obj): unknown;
};
const datatableSource = nodeRequire('../datatableSource') as { isDatatableBacked(t: unknown): boolean };
const quota = (): { assertRowQuota(a: App, key: string): Promise<void>; assertDbByteQuota(a: App): Promise<void> } => nodeRequire('../studioAppQuota');
const dbStore = (): { batch(o: string, a: string, s: Statement[]): Promise<BatchResult> } => nodeRequire('../../stores/studioAppDbStore');
const bulk = (): { compileDeleteMatching(t: unknown, f: Filter[], a: unknown, o: Obj): Statement } => nodeRequire('../../core/dataEngine/queryCompilerBulk.mts');

const deletedOf = (results: BatchResult): number => Number(results && results[0] && results[0].changes) || 0;

export async function replaceRecordBatch(app: App, _model: unknown, table: Table, rows: Obj[], { viewer, filters, limit }: ReplaceOpts): Promise<{ ids: string[]; deleted: number }> {
    const viewerId = viewer && typeof viewer === 'object' ? (viewer as Viewer).id : undefined;
    const list = applyFieldRulesToRows(table, Array.isArray(rows) ? rows : [], { op: 'create', viewerId });
    if (datatableSource.isDatatableBacked(table)) return replaceDatatableBatch(app, table, list, { viewer, filters, limit });
    const v: Viewer = (viewer && typeof viewer === 'object') ? viewer as Viewer : {};
    const role = v.role ?? null;
    rlsGateway.assertCanWrite(table, role, 'delete');
    rlsGateway.assertCanWrite(table, role, 'create');
    if (list.length) {
        await quota().assertRowQuota(app, table.key);
        await quota().assertDbByteQuota(app);
    }
    const access = rlsGateway.compileAccessFilter(table, role, v, 'delete');
    const del = bulk().compileDeleteMatching(table, filters, access, { limit });
    const { statements, ids } = records.compileInserts(table, list, { createdBy: v.id ?? null, orgId: app.organizationId || null });
    const deleted = deletedOf(await dbStore().batch(app.userId, app.id, [del, ...statements]));
    await bumpVersion(app, table.key);
    if (ids.length - deleted) await bumpCount(app, table.key, ids.length - deleted);
    return { ids, deleted };
}

/** The datatable branch of replaceRecordBatch: the same one batch, on the datatable store. */
async function replaceDatatableBatch(app: App, table: Table, list: Obj[], { viewer, filters, limit }: ReplaceOpts): Promise<{ ids: string[]; deleted: number }> {
    const bound = await records.resolveWrite(app, table, viewer, 'create');
    const delBound = await records.resolveWrite(app, table, viewer, 'delete');
    if (records.isSourceMirror(bound)) {
        throw Object.assign(new Error('replaceWhere cannot run on a table that mirrors an external source.'), { status: 422, safe: true, code: 'replace_on_mirror' });
    }
    queryCompiler.assertRowsWritable(bound.tableMeta);
    const { assertDatatableQuota } = nodeRequire('../../core/dataEngine/datatableLimits') as { assertDatatableQuota(scope: unknown, o: Obj): Promise<void> };
    if (list.length) await assertDatatableQuota(bound.scope, { table: bound.datatable, addRows: list.length });
    const access = rlsGateway.compileAccessFilter(delBound.tableMeta, delBound.grade, delBound.viewer, 'delete', { dialect: delBound.dialect });
    const del = bulk().compileDeleteMatching(bound.tableMeta, filters, access, { dialect: bound.dialect, limit });
    const { statements, ids } = records.compileInserts(bound.tableMeta, list, {
        createdBy: bound.viewer.id ?? null, orgId: bound.datatable.organizationId || null, dialect: bound.dialect,
    });
    const deleted = deletedOf(await records.dtStore().batch(bound.scopeKey, bound.scopeKey, [del, ...statements]));
    await bumpDatatable(bound, ids.length - deleted);
    return { ids, deleted };
}
