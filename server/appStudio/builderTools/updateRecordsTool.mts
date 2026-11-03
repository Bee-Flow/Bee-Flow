/**
 * app_update_records: change existing rows of an app table, with the SAME validation,
 * RLS and quota checks as a record update made from the running app.
 *
 * Every write goes through actionExecutor.writeRecord, the single record-write choke
 * point (column validation and coercion, byte quota, the viewer's access filter in the
 * WHERE). The viewer is the CALLER's resolved role in the app (rlsGateway
 * .resolveViewerRole), never a blanket owner: a role that may only edit its own rows
 * is refused on the others, per row. (Over MCP the caller is the app's owner today, so
 * the resolved role is 'owner'; the resolution still runs so the day a non-owner can
 * reach this tool, the role limits apply without a code change.)
 *
 * Two forms:
 *   updates: [{ id, values }]          1..25 rows, each its own result
 *   filter + values (+ max, dry_run)   rows matching a filter, up to `max` (<= 200);
 *                                      dry_run (default true) only reports what would change
 *
 * A linked table (rows in a Studio datatable) is refused: its rows are not this app's.
 * Record updates are not audited anywhere else (the app's data route does not log
 * them either), so nothing extra is written here.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, unknown>;
type Field = { key: string };
type Table = { id: string; key: string; name?: string; fields?: Field[]; source?: unknown };
type Model = { tables?: Table[] } & Record<string, unknown>;
type Draft = { userId: string; orgId?: string | null; appId?: string | null; dataModel?: Model | null };
type Args = { tableId?: unknown; updates?: unknown; filter?: unknown; values?: unknown; max?: unknown; dry_run?: unknown };
type Result = Record<string, unknown>;
type App = { id: string; userId: string; organizationId?: string | null };
type Viewer = { id: string; role: string | null; organizationId: string | null };
type CodedError = Error & { code?: string; safe?: boolean; status?: number };

const { MAX_UPDATE_RECORDS, MAX_FILTER_UPDATE_ROWS, DEFAULT_FILTER_UPDATE_ROWS } = nodeRequire('./schemaFragments') as {
    MAX_UPDATE_RECORDS: number; MAX_FILTER_UPDATE_ROWS: number; DEFAULT_FILTER_UPDATE_ROWS: number;
};
const { findModelTable, tableIdHint } = nodeRequire('./dataToolsShared') as {
    findModelTable: (model: Model | null | undefined, ref: unknown) => Table | null;
    tableIdHint: (model: Model | null | undefined) => string;
};
const { isDatatableBacked } = nodeRequire('../datatableSource') as { isDatatableBacked: (t: Table) => boolean };
const { FILTER_OPS } = nodeRequire('../dataModel') as { FILTER_OPS: string[] };
const log = nodeRequire('../../telemetry/log') as { warn: (m: string, meta?: unknown) => void };

const MAX_FILTER_CLAUSES = 20;
const NOT_CHANGED = 'Not changed: the row does not exist, or it is outside what your role may update.';

const fail = (error: string, _fixHint?: string): Result => ({ error, ...(_fixHint ? { _fixHint } : {}) });
const isPlainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v);

/** A thrown write/read error as text for the caller: only messages written for a reader are quoted. */
function describeFailure(e: unknown, where: string): { error: string; code?: string } {
    const err = e as CodedError;
    const compiler = nodeRequire('../queryCompiler') as { CompileError: new (...a: never[]) => Error };
    const rls = nodeRequire('../rlsGateway') as { AccessError: new (...a: never[]) => Error };
    const refusal = (C: new (...a: never[]) => Error): boolean => (e as unknown) instanceof C;
    if (refusal(compiler.CompileError) || refusal(rls.AccessError) || err?.safe === true || err?.code === 'quota_exceeded') {
        return { error: err.message, ...(err.code ? { code: err.code } : {}) };
    }
    log.warn(`app_update_records ${where} failed`, { error: err?.message });
    return { error: 'The update could not be run (details are in the server log).' };
}

async function loadApp(draftWrap: Draft): Promise<App | Result> {
    if (!draftWrap.appId) return fail('This app has no data yet. Create a table with app_upsert_table first.');
    const studioAppStore = nodeRequire('../../stores/studioAppStore') as { getStudioApp: (id: string) => Promise<App | null> };
    try {
        const app = await studioAppStore.getStudioApp(draftWrap.appId);
        return app ?? fail('This app no longer exists. It may have been deleted in another tab.');
    } catch (e) {
        return fail(`Could not load the app: ${(e as Error).message}`);
    }
}

/** The caller's role in the app; null (no data access) is a refusal, never a fallback to owner. */
async function viewerFor(app: App, draftWrap: Draft, model: Model): Promise<Viewer | Result> {
    const rls = nodeRequire('../rlsGateway') as { resolveViewerRole: (a: App, userId: string, m: Model, aud: object) => Promise<string | null> };
    let role: string | null = null;
    try {
        role = await rls.resolveViewerRole(app, draftWrap.userId, model, { userGroups: [] });
    } catch (e) {
        log.warn('app_update_records role resolution failed', { error: (e as Error).message });
        return fail('Could not resolve your role in this app, so nothing was changed.');
    }
    if (!role) return fail('You have no role in this app, so you may not change its data.');
    return { id: draftWrap.userId, role, organizationId: draftWrap.orgId ?? null };
}

function checkValues(values: unknown, what: string): string | null {
    if (!isPlainObject(values) || !Object.keys(values).length) return `${what} must be a non-empty object of { fieldKey: value }.`;
    return null;
}

type UpdateOne = { id: string; values: Row };

type Parsed = { items: UpdateOne[]; invalid: Array<{ index: number; error: string }>; refusal?: undefined } | { refusal: Result };

function parseUpdates(raw: unknown): Parsed {
    const refuse = (r: Result): Parsed => ({ refusal: r });
    if (!Array.isArray(raw) || !raw.length) return refuse(fail(`updates must be a non-empty array of { id, values } (1 to ${MAX_UPDATE_RECORDS}).`));
    if (raw.length > MAX_UPDATE_RECORDS) {
        return refuse(fail(`updates: at most ${MAX_UPDATE_RECORDS} rows per call (got ${raw.length}).`, 'Split the updates over more calls, or use the filter form for a bulk change.'));
    }
    const items: UpdateOne[] = [];
    const invalid: Array<{ index: number; error: string }> = [];
    const seen = new Set<string>();
    raw.forEach((u, index) => {
        const entry = isPlainObject(u) ? u : null;
        const id = entry && typeof entry.id === 'string' ? entry.id.trim() : '';
        if (!id) { invalid.push({ index, error: 'each update needs the record id (rec_…) as `id`' }); return; }
        const bad = checkValues(entry?.values, 'values');
        if (bad) { invalid.push({ index, error: bad }); return; }
        if (seen.has(id)) { invalid.push({ index, error: `record ${id} appears twice in this call` }); return; }
        seen.add(id);
        items.push({ id, values: entry!.values as Row });
    });
    return { items, invalid };
}

type WriteRecord = (app: App, model: Model, table: Table, values: Row, opts: { viewer: Viewer; recordId: string }) => Promise<{ changes?: number }>;

async function writeOne(app: App, model: Model, table: Table, viewer: Viewer, item: UpdateOne): Promise<Row & { ok: boolean }> {
    const { writeRecord } = nodeRequire('../actionExecutor') as { writeRecord: WriteRecord };
    try {
        const { changes } = await writeRecord(app, model, table, item.values, { viewer, recordId: item.id });
        return changes ? { id: item.id, ok: true } : { id: item.id, ok: false, error: NOT_CHANGED };
    } catch (e) {
        return { id: item.id, ok: false, ...describeFailure(e, 'write') };
    }
}

function validateFilter(filter: unknown): Result | null {
    if (!Array.isArray(filter) || !filter.length) {
        return fail('filter must be a non-empty array of { field, op, value? }. An empty filter would match every row.', `ops: ${FILTER_OPS.join(', ')}.`);
    }
    if (filter.length > MAX_FILTER_CLAUSES) return fail(`filter: at most ${MAX_FILTER_CLAUSES} clauses.`);
    const bad = filter.findIndex((c) => !isPlainObject(c) || typeof c.field !== 'string' || !c.field || typeof c.op !== 'string' || !FILTER_OPS.includes(c.op));
    if (bad >= 0) return fail(`filter[${bad}] must be { field, op, value? } with op one of ${FILTER_OPS.join(', ')}.`);
    return null;
}

function parseMax(raw: unknown): number | Result {
    if (raw === undefined || raw === null) return DEFAULT_FILTER_UPDATE_ROWS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > MAX_FILTER_UPDATE_ROWS) return fail(`max must be a whole number from 1 to ${MAX_FILTER_UPDATE_ROWS} (default ${DEFAULT_FILTER_UPDATE_ROWS}).`);
    return n;
}

type ReadRunner = {
    runInlineAggregate: (ctx: object, table: Table, d: object) => Promise<{ rows: Row[] }>;
    runRecordList: (ctx: object, table: Table, o: object) => Promise<{ records: Row[] }>;
};

/** Rows matching the filter under the caller's READ scope: how many, and the first `max` ids. */
async function matchFilter(app: App, model: Model, table: Table, viewer: Viewer, filter: unknown[], max: number): Promise<{ matched: number; ids: string[] }> {
    const reader = nodeRequire('../dataReadRunner') as ReadRunner;
    const ctx = { app, ownerScope: app.userId, viewerId: viewer.id, role: viewer.role, viewer, model };
    const counted = await reader.runInlineAggregate(ctx, table, { filters: filter, aggregates: [{ fn: 'count', as: 'n' }] });
    const matched = Number(counted.rows?.[0]?.n) || 0;
    if (!matched) return { matched: 0, ids: [] };
    const page = await reader.runRecordList(ctx, table, { filters: filter, sort: { field: 'created_at', dir: 'asc' }, limit: max });
    return { matched, ids: (page.records || []).map((r) => String(r.id)).slice(0, max) };
}

async function updateByFilter(app: App, model: Model, table: Table, viewer: Viewer, args: Args): Promise<Result> {
    const filterIssue = validateFilter(args.filter);
    if (filterIssue) return filterIssue;
    const valuesIssue = checkValues(args.values, 'values');
    if (valuesIssue) return fail(valuesIssue);
    const max = parseMax(args.max);
    if (typeof max !== 'number') return max;
    const dryRun = args.dry_run !== false;

    let found: { matched: number; ids: string[] };
    try {
        found = await matchFilter(app, model, table, viewer, args.filter as unknown[], max);
    } catch (e) {
        return fail(`Filter failed: ${describeFailure(e, 'filter').error}`, `Fields must exist on "${table.key}" (${(table.fields || []).map((f) => f.key).join(', ')}) or be system columns; ops: ${FILTER_OPS.join(', ')}.`);
    }
    const capped = found.matched > found.ids.length;
    if (dryRun) {
        return {
            dry_run: true,
            matched: found.matched,
            wouldUpdate: found.ids.length,
            ids: found.ids.slice(0, 20),
            ...(capped ? { capped: true, note: `${found.matched} rows match; a real run changes at most max=${max}.` } : {}),
            _hints: ['Nothing was written. Row-level write rules still apply per row on the real run (pass dry_run:false). Check the ids with app_query_data before you run it.'],
        };
    }
    const results: Array<Row & { ok: boolean }> = [];
    for (const id of found.ids) results.push(await writeOne(app, model, table, viewer, { id, values: args.values as Row }));
    const updated = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    return {
        matched: found.matched,
        updated,
        ...(failed.length ? { failed: failed.length, results: failed } : {}),
        ...(capped ? { capped: true, note: `${found.matched - found.ids.length} matching rows were left (max=${max}); run again to continue.` } : {}),
        tableId: table.id,
    };
}

async function updateByIds(app: App, model: Model, table: Table, viewer: Viewer, args: Args): Promise<Result> {
    const parsed = parseUpdates(args.updates);
    if (parsed.refusal) return parsed.refusal;
    const results: Array<Row & { ok: boolean }> = [];
    for (const item of parsed.items) results.push(await writeOne(app, model, table, viewer, item));
    for (const bad of parsed.invalid) results.push({ ok: false, index: bad.index, error: bad.error });
    const updated = results.filter((r) => r.ok).length;
    if (!updated) {
        return { error: `None of the ${results.length} update(s) was applied.`, results, _fixHint: `Field keys must exist on "${table.key}" (${(table.fields || []).map((f) => f.key).join(', ')}); ids are rec_… ids from app_query_data.` };
    }
    return { updated, tableId: table.id, results };
}

export async function applyUpdateRecords(draftWrap: Draft, args: Args = {}): Promise<Result> {
    const hasUpdates = args?.updates !== undefined && args.updates !== null;
    const hasFilter = args?.filter !== undefined && args.filter !== null;
    if (hasUpdates === hasFilter) {
        return fail('Pass either `updates` ([{ id, values }]) or `filter` + `values`, not both and not neither.');
    }
    const model = draftWrap.dataModel;
    const table = findModelTable(model, args.tableId);
    if (!model || !table) {
        return fail(`Unknown tableId ${JSON.stringify(args.tableId)}.`, tableIdHint(model));
    }
    if (isDatatableBacked(table)) {
        return fail(`"${table.name || table.key}" is a LINKED table: its rows live in a Studio table and are not changed from this app.`, 'Change the rows in the Studio table itself (or through an automation); this tool only updates the app\'s own tables.');
    }
    const app = await loadApp(draftWrap);
    if ('error' in app) return app;
    const viewer = await viewerFor(app as App, draftWrap, model);
    if ('error' in viewer) return viewer;

    // Refused up front when the role has no update right on this table at all.
    try {
        (nodeRequire('../rlsGateway') as { assertCanWrite: (t: Table, role: string | null, a: string) => void }).assertCanWrite(table, (viewer as Viewer).role, 'update');
    } catch (e) {
        return fail(describeFailure(e, 'permission').error);
    }
    return hasUpdates
        ? updateByIds(app as App, model, table, viewer as Viewer, args)
        : updateByFilter(app as App, model, table, viewer as Viewer, args);
}
