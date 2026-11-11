/**
 * captureFromApp — the I/O half of a template capture (the pure half is templateCapture.js
 * captureTemplate). Reads the app's rows for the named tables, the links of their many
 * relations, its datasets and the uploaded files its definition refers to, then hands them to
 * captureTemplate.
 *
 * Rows are read through the SAME compiled-query + RLS path app_query_data uses
 * (queryCompiler.compileRecordList with an owner access filter), not raw SQL —
 * a capture must not be able to read rows the caller could not read in the app.
 *
 * `userId` is the caller (must own/be able to edit the app), `definition` the
 * canonical draft definition, `seedTables` the table IDS whose rows to capture
 * (default none).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
type Table = { id?: string; key?: string; fields?: unknown; source?: unknown };
type CaptureResult = { ok: boolean; errors?: string[]; _fixHint?: string; template?: Obj; report?: { warnings: string[] } & Obj };

const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The rows of the wanted tables, as the owner reads them, with their many-relation links filled. */
async function readSeedRows(appId: string, userId: string, dataModel: unknown, tables: Table[], wanted: Set<string>, max: number): Promise<Record<string, Obj[]> | { error: string }> {
    const rowsByTable: Record<string, Obj[]> = {};
    if (!wanted.size) return rowsByTable;
    const queryCompiler = nodeRequire('./queryCompiler') as { compileRecordList: (t: Table, d: Obj, f: unknown) => { sql: string; params: unknown[] } };
    const rlsGateway = nodeRequire('./rlsGateway') as { compileAccessFilter: (t: Table, role: string, viewer: Obj, action: string) => unknown };
    const db = nodeRequire('../stores/studioAppDbStore') as { query: (owner: string, appId: string, sql: string, params: unknown[]) => Promise<{ rows?: Obj[] }> };
    const { fillManyLinks } = nodeRequire('./templateCaptureLinks.mts') as typeof import('./templateCaptureLinks.mts');
    for (const table of tables) {
        if (!table.id || !wanted.has(table.id)) continue;
        try {
            const accessFilter = rlsGateway.compileAccessFilter(table, 'owner', { id: userId }, 'read');
            const { sql, params } = queryCompiler.compileRecordList(table, { limit: max }, accessFilter);
            const out = await db.query(userId, appId, sql, params);
            const rows = (Array.isArray(out.rows) ? out.rows : []).slice(0, max);
            // The links of many relations are junction rows, not columns: read them as a list per row.
            await fillManyLinks(dataModel, table, rows, { appId, userId });
            rowsByTable[table.id] = rows;
        } catch (e) {
            return { error: `Could not read rows from ${table.key}: ${reason(e)}` };
        }
    }
    return rowsByTable;
}

export async function captureFromApp({ appId, userId, definition, dataModel = null, seedTables = [], meta = {} }: {
    appId: string; userId: string; definition: unknown; dataModel?: Obj | null; seedTables?: string[]; meta?: Obj;
}): Promise<CaptureResult> {
    const wanted = new Set((Array.isArray(seedTables) ? seedTables : []).filter((t) => typeof t === 'string' && t));
    const tables = (isObject(dataModel) && Array.isArray(dataModel.tables) ? dataModel.tables : []) as Table[];

    const unknown = [...wanted].filter((id) => !tables.some((t) => t.id === id));
    if (unknown.length) {
        return {
            ok: false,
            errors: [`Unknown seedTables id(s): ${unknown.join(', ')}.`],
            _fixHint: `Known table ids: ${tables.map((t) => `${t.id} (${t.key})`).join(', ') || '(none)'}.`,
        };
    }

    const { MAX_SEED_ROWS_PER_TABLE } = nodeRequire('./templateInstall') as { MAX_SEED_ROWS_PER_TABLE: number };
    const rowsByTable = await readSeedRows(appId, userId, dataModel, tables, wanted, MAX_SEED_ROWS_PER_TABLE);
    if ('error' in rowsByTable && typeof rowsByTable.error === 'string') return { ok: false, errors: [rowsByTable.error] };

    let datasets: unknown[] = [];
    try {
        const studioAppDataStore = nodeRequire('../stores/studioAppDataStore') as { listDatasets: (a: string, u: string) => Promise<unknown[] | null> };
        datasets = await studioAppDataStore.listDatasets(appId, userId) || [];
    } catch (e) {
        // A dataset listing that will not answer must not sink the capture —
        // the definition and model are the substance.
        (nodeRequire('../telemetry/log') as { warn: (m: string) => void }).warn(`[templateCapture] dataset listing failed for ${appId}: ${reason(e)}`);
    }

    // The uploaded files the definition refers to travel with it (portableAssetStore.mts).
    const { collectPortableAssets } = nodeRequire('./portableAssetStore.mts') as typeof import('./portableAssetStore.mts');
    const files = await collectPortableAssets({ id: appId, userId }, definition);
    const { captureTemplate } = nodeRequire('./templateCapture') as { captureTemplate: (o: Obj) => CaptureResult };
    const captured = captureTemplate({
        definition, dataModel, rowsByTable, datasets, meta, maxSeedRows: MAX_SEED_ROWS_PER_TABLE, assets: files.assets,
    });
    if (captured.ok && captured.report && files.left.length) captured.report.warnings.unshift(...files.left.map((why) => `Uploaded file left out: ${why}.`));
    return captured;
}
