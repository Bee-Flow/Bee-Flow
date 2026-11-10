/**
 * App Studio compatibility corpus: the SQL today's code compiles for an app's data reads.
 *
 * Which reads: every record / records / aggregate / dataset binding on every screen
 * (collectDataBindings over the STORED definition, which is what the runtime serves), plus every
 * saved dataset the app carries. For whom: the owner, each role of the data model, and the
 * reserved `public` role when the definition has publicAccess. In which dialect: sqlite and pg
 * (the utils/engineFlag test override, restored afterwards).
 *
 * How, without a database:
 *   - The read descriptor is the one the runtime posts to /data/batch for a run view
 *     (agent-hub runtime/useAppDataSource batchDescriptor): record and records become
 *     { filters, sort, limit }, aggregate { filters, groupBy, aggregates, sort, limit }, all
 *     taken from the binding. Formula filter values are resolved by the server's statement of
 *     the client contract, appDryRunReads.resolveDryRunFilters, against the dry-run scope with
 *     a fixed clock (COMPAT_NOW), so a `today` filter compiles to the same params every run.
 *   - It is compiled as dataReadRunner compiles a read of the app's own table: the canRead gate,
 *     compileAccessFilter for the role, then compileRecordList / compileAggregate.
 *   - A saved dataset compiles as datasetCache.runDataset does on a cache miss: canRead,
 *     compileAccessFilter, compileAggregate over the descriptor's filters, groupBy, aggregates,
 *     sort and limit.
 *
 * Not SQL, recorded as what they are: a table that reads a linked Studio datatable (its columns
 * come from that datatable at run time, so the descriptor handed over is recorded), a filter or
 * aggregate shape that needs live scope (`skipped: dynamic`), a binding whose table is not in
 * the model (`skipped: unresolved`), a role without read access, and a compile error.
 */

import { createRequire } from 'node:module';
import { isObject } from './corpus.mts';
import type { CorpusEntry, Obj } from './corpus.mts';

const nodeRequire = createRequire(import.meta.url);

type Binding = Obj & { kind: string; tableId?: string; datasetId?: string };
type Identity = { role: string; viewer: Obj };
type Compiled = { sql: string; params: unknown[] };

const { collectDataBindings } = nodeRequire('../collectDataBindings') as { collectDataBindings: (def: unknown) => { nodeId: string | null; prop: string; binding: Binding }[] };
const dryRunReads = nodeRequire('../appDryRunReads') as {
    syntheticScope: (viewer: Obj, variables: unknown) => Obj;
    resolveDryRunFilters: (binding: Obj, scope: Obj) => { filters?: unknown; skipped?: boolean };
};
const engineFlag = nodeRequire('../../utils/engineFlag') as { _setForTests: (d: string | null) => void };
const accessFilter = nodeRequire('../../core/dataEngine/accessFilter') as {
    canRead: (table: Obj, role: string) => boolean;
    compileAccessFilter: (table: Obj, role: string, viewer: Obj, action: string) => unknown;
};
const queryCompiler = nodeRequire('../queryCompiler') as {
    compileRecordList: (table: Obj, opts: Obj, access: unknown) => Compiled;
    compileAggregate: (table: Obj, opts: Obj, access: unknown) => Compiled;
};
const { isDatatableBacked } = nodeRequire('../datatableSource') as { isDatatableBacked: (table: Obj) => boolean };

export const COMPAT_NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
export const DIALECTS = ['sqlite', 'pg'];
const OWNER_ID = 'usr_compat_owner';
/** The aggregate fields the client resolves when they are authored as a formula. */
const AGGREGATE_SHAPE_FIELDS = ['groupBy', 'aggregates', 'sort', 'limit'];

function findTable(model: Obj, ref: unknown): Obj | null {
    if (typeof ref !== 'string' || !ref) return null;
    const tables = Array.isArray(model.tables) ? model.tables.filter(isObject) : [];
    return tables.find((t) => t.id === ref || t.key === ref) ?? null;
}

/** The owner, each role the data model declares, and `public` when the app has a public page. */
function identities(entry: CorpusEntry): Identity[] {
    const out: Identity[] = [{ role: 'owner', viewer: { id: OWNER_ID } }];
    const roles = entry.dataModel && Array.isArray(entry.dataModel.roles) ? entry.dataModel.roles : [];
    for (const r of roles) {
        if (isObject(r) && typeof r.key === 'string') out.push({ role: r.key, viewer: { id: `usr_compat_${r.key}`, role: r.key } });
    }
    if (isObject(entry.definition) && isObject(entry.definition.publicAccess)) out.push({ role: 'public', viewer: { id: 'anon:compat', role: 'public' } });
    return out;
}

function fixedScope(viewer: Obj, variables: unknown): Obj {
    return { ...dryRunReads.syntheticScope(viewer, variables), now: COMPAT_NOW, today: new Date(COMPAT_NOW).toISOString().slice(0, 10) };
}

/** The descriptor the runtime posts for this binding (run view, not the editor's sample). */
function descriptorOf(binding: Binding, filters: unknown): Obj {
    if (binding.kind === 'aggregate') {
        return { filters, groupBy: binding.groupBy, aggregates: binding.aggregates, sort: binding.sort, limit: binding.limit };
    }
    return { filters, sort: binding.sort, limit: binding.limit };
}

function compileFor(table: Obj, kind: string, descriptor: Obj, who: Identity): Obj {
    try {
        const access = accessFilter.compileAccessFilter(table, who.role, who.viewer, 'read');
        const compiled = kind === 'aggregate'
            ? queryCompiler.compileAggregate(table, descriptor, access)
            : queryCompiler.compileRecordList(table, descriptor, access);
        return { sql: compiled.sql, params: compiled.params };
    } catch (e) {
        return { error: e instanceof Error ? e.message : String(e) };
    }
}

function bindingRead(entry: CorpusEntry, binding: Binding, who: Identity): Obj {
    const table = findTable(entry.dataModel ?? {}, binding.tableId);
    if (!table) return { skipped: 'unresolved' };
    if (!accessFilter.canRead(table, who.role)) return { note: 'no read access for this role' };
    if (binding.kind === 'aggregate' && AGGREGATE_SHAPE_FIELDS.some((f) => isObject(binding[f]) && (binding[f] as Obj).kind === 'formula')) {
        return { skipped: 'dynamic' };
    }
    const def = isObject(entry.definition) ? entry.definition : {};
    const resolved = dryRunReads.resolveDryRunFilters(binding, fixedScope(who.viewer, def.variables));
    if (resolved.skipped) return { skipped: 'dynamic' };
    const descriptor = descriptorOf(binding, resolved.filters);
    if (isDatatableBacked(table)) return { linked: descriptor };
    return compileFor(table, binding.kind, descriptor, who);
}

/** A saved dataset, compiled the way datasetCache.runDataset compiles a cache miss. */
function datasetRead(entry: CorpusEntry, datasetId: unknown, who: Identity): Obj {
    const ds = (entry.datasets ?? []).find((d) => d.id === datasetId);
    if (!ds) return { skipped: 'unresolved' };
    const descriptor = isObject(ds.descriptor) ? ds.descriptor : {};
    const table = findTable(entry.dataModel ?? {}, ds.tableId ?? descriptor.tableId);
    if (!table) return { skipped: 'unresolved' };
    if (!accessFilter.canRead(table, who.role)) return { note: 'no read access for this role' };
    if (isDatatableBacked(table)) return { skipped: 'linked' };
    return compileFor(table, 'aggregate', {
        filters: descriptor.filters, groupBy: descriptor.groupBy, aggregates: descriptor.aggregates,
        sort: descriptor.sort, limit: descriptor.limit,
    }, who);
}

function readFor(entry: CorpusEntry, binding: Binding, who: Identity): Obj {
    return binding.kind === 'dataset' ? datasetRead(entry, binding.datasetId, who) : bindingRead(entry, binding, who);
}

/** The read list of an app: on-screen bindings first (in walk order), then its saved datasets. */
function readList(entry: CorpusEntry): { at: string; binding: Binding }[] {
    const list = collectDataBindings(entry.definition).map(({ nodeId, prop, binding }) => ({ at: `${nodeId ?? '?'}.${prop}`, binding }));
    for (const ds of entry.datasets ?? []) list.push({ at: `dataset ${String(ds.id)}`, binding: { kind: 'dataset', datasetId: String(ds.id) } });
    return list;
}

function inDialect<T>(dialect: string, fn: () => T): T {
    engineFlag._setForTests(dialect);
    try {
        return fn();
    } finally {
        engineFlag._setForTests(null);
    }
}

/**
 * The frozen `reads` section: per read `{ at, kind, table?, sqlite, pg }`, each dialect a map of
 * role → outcome. Null when the app has no data model (there is nothing to compile against).
 */
export function readsSection(entry: CorpusEntry): Obj[] | null {
    if (!entry.dataModel) return null;
    const who = identities(entry);
    const rows = readList(entry).map(({ at, binding }) => {
        const row: Obj = { at, kind: binding.kind };
        if (typeof binding.tableId === 'string') row.table = binding.tableId;
        for (const dialect of DIALECTS) {
            row[dialect] = inDialect(dialect, () => Object.fromEntries(who.map((w) => [w.role, readFor(entry, binding, w)])));
        }
        return row;
    });
    // As JSON holds it: a descriptor member the binding leaves out is absent, not undefined.
    return JSON.parse(JSON.stringify(rows)) as Obj[];
}
