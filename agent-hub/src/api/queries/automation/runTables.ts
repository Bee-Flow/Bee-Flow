// The tables a run kept (read_table, table): the handle a step's output
// carries, and the two read routes behind it (server/routes/automation/
// runTables.js). The rows need the session, so they are fetched with it, a page
// at a time, and the CSV is handed to the browser as a blob, never linked.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { failure } from './http';

type TableColumnType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'mixed' | 'empty';

export interface TableColumn {
    key: string;
    label: string;
    type: TableColumnType;
}

/** What a step's output holds for a table: where it is kept, its columns and the first rows. */
export interface TableHandle {
    kind: 'table';
    tableId: string;
    /** The run that wrote it. It can be an earlier run of the same automation. */
    runId: string | null;
    name: string;
    columns: TableColumn[];
    rowCount: number;
    preview: Record<string, unknown>[];
    previewCut?: boolean;
    expiresAt: string | null;
    provenance: Record<string, string> | null;
}

/** One page of rows, as GET /runs/:runId/tables/:tableId answers. */
export interface RunTablePage {
    tableId: string;
    name: string;
    runId: string | null;
    columns: TableColumn[];
    rowCount: number;
    offset: number;
    limit: number;
    rows: Record<string, unknown>[];
    hasMore: boolean;
    expiresAt: string | null;
}

/** The id a kept table has. A dry run's placeholder ('dry-run') is not one. */
const TABLE_ID_RE = /^rtb_[0-9a-f]{32}$/;
const COLUMN_TYPES: readonly string[] = ['text', 'number', 'boolean', 'date', 'datetime', 'mixed', 'empty'];
const MAX_TABLES = 50;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function columnOf(v: unknown): TableColumn | null {
    if (!isRecord(v)) return null;
    const key = text(v.key);
    if (!key) return null;
    return { key, label: text(v.label) ?? key, type: COLUMN_TYPES.includes(v.type as string) ? v.type as TableColumnType : 'text' };
}

/** True for the handle of a kept table (not a dry run's placeholder, not a look-alike). */
export function isTableHandle(v: unknown): v is TableHandle {
    return isRecord(v)
        && v.kind === 'table'
        && typeof v.tableId === 'string' && TABLE_ID_RE.test(v.tableId)
        && typeof v.name === 'string'
        && Array.isArray(v.columns)
        && typeof v.rowCount === 'number' && Number.isFinite(v.rowCount);
}

/** The handle with every optional part filled in, so the views never test for it. */
function normalised(h: TableHandle): TableHandle {
    const provenance = isRecord(h.provenance) ? h.provenance as Record<string, string> : null;
    return {
        ...h,
        runId: text(h.runId),
        columns: h.columns.map(columnOf).filter((c): c is TableColumn => c !== null),
        preview: Array.isArray(h.preview) ? h.preview.filter(isRecord) : [],
        expiresAt: text(h.expiresAt),
        provenance,
    };
}

/**
 * The kept tables a step's output points at: `output.table` (the one a table
 * step makes, the first sheet of a read) and `output.tables[]` (one per sheet),
 * once each by id. A dry run's placeholder is skipped.
 */
export function tableHandlesIn(output: unknown): TableHandle[] {
    if (!isRecord(output)) return [];
    const found = new Map<string, TableHandle>();
    const take = (v: unknown) => {
        if (found.size < MAX_TABLES && isTableHandle(v) && !found.has(v.tableId)) found.set(v.tableId, normalised(v));
    };
    take(output.table);
    if (Array.isArray(output.tables)) output.tables.forEach(take);
    return [...found.values()];
}

const tableUrl = (runId: string, tableId: string, tail = '') =>
    `${API_BASE}/api/automation/runs/${encodeURIComponent(runId)}/tables/${encodeURIComponent(tableId)}${tail}`;

export async function fetchRunTablePage(runId: string, tableId: string, offset: number, limit: number, signal?: AbortSignal): Promise<RunTablePage> {
    const res = await authFetch(tableUrl(runId, tableId, `?offset=${Math.max(0, Math.floor(offset))}&limit=${Math.max(1, Math.floor(limit))}`), { signal });
    if (!res.ok) throw await failure(res, `Table ${res.status}`);
    const body: unknown = await res.json();
    const b = isRecord(body) ? body : {};
    const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    return {
        tableId,
        name: text(b.name) ?? 'Table',
        runId: text(b.runId),
        columns: (Array.isArray(b.columns) ? b.columns : []).map(columnOf).filter((c): c is TableColumn => c !== null),
        rowCount: num(b.rowCount, 0),
        offset: num(b.offset, offset),
        limit: num(b.limit, limit),
        rows: (Array.isArray(b.rows) ? b.rows : []).filter(isRecord),
        hasMore: b.hasMore === true,
        expiresAt: text(b.expiresAt),
    };
}

const runTableKeys = {
    page: (runId: string, tableId: string, offset: number, limit: number) => ['automation', 'run-table', runId, tableId, offset, limit] as const,
};

/** One page of a kept table. A page already seen is served from memory; an expired table (404) is not retried. */
export function useRunTablePage(runId: string | null | undefined, tableId: string | null | undefined, offset: number, limit: number) {
    return useQuery({
        queryKey: runTableKeys.page(runId || '', tableId || '', offset, limit),
        queryFn: ({ signal }) => fetchRunTablePage(runId as string, tableId as string, offset, limit, signal),
        enabled: !!runId && !!tableId,
        staleTime: 60_000,
        retry: false,
    });
}

/** The name as a file name: no folders, no characters a file system refuses. */
function csvFileName(name: string): string {
    const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    return `${cleaned || 'table'}.csv`;
}

/** Save the whole table as a CSV file through the browser's download. */
export async function downloadRunTableCsv(runId: string, tableId: string, name: string): Promise<void> {
    const res = await authFetch(tableUrl(runId, tableId, '/csv'));
    if (!res.ok) throw await failure(res, `Download ${res.status}`);
    const url = URL.createObjectURL(await res.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = csvFileName(name);
    link.click();
    // Chrome needs the object URL to outlive the click.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
