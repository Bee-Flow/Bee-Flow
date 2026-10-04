// Client for /api/studio-documents/:id/sheet (the cells of a spreadsheet document).
// `/api` is part of the path, not of API_BASE (see documentsApi.js).

import { API_BASE, authFetch } from '../../../utils/helpers';

const BASE = `${API_BASE}/api/studio-documents`;

export interface SheetTab {
    id: string;
    name: string;
}

export interface SheetData {
    columns: number;
    /** The number of rows in use. */
    rows: number;
    /** Raw text per cell name: "12", "hello", "=SUM(A1:A5)". */
    cells: Record<string, string>;
    readOnly: boolean;
    /** Tabs when the backend supports multi-sheet spreadsheets. */
    tabs?: SheetTab[];
    /** The id of the tab these cells belong to. */
    activeTab?: string;
}

/** The server may take this many cells in one PATCH. */
export const MAX_CELLS_PER_REQUEST = 500;

export class SheetApiError extends Error {
    status: number;
    code?: string;
    constructor(message: string, status: number, code?: string) {
        super(message);
        this.name = 'SheetApiError';
        this.status = status;
        this.code = code;
    }
}

const sheetUrl = (id: string, suffix = '') => `${BASE}/${encodeURIComponent(id)}/sheet${suffix}`;

function tabQuery(tabId?: string) {
    return tabId ? `?tab=${encodeURIComponent(tabId)}` : '';
}

async function asJson<T>(res: Response, fallback: string): Promise<T> {
    let body: any = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new SheetApiError((body && body.error) || fallback, res.status, body?.code);
    if (body === null) throw new SheetApiError(fallback, res.status, 'not_json');
    return body as T;
}

export async function getSheet(id: string, tabId?: string): Promise<SheetData> {
    const res = await authFetch(sheetUrl(id) + tabQuery(tabId));
    const body = await asJson<Partial<SheetData>>(res, 'Failed to load the spreadsheet');
    return {
        columns: Number(body.columns) || 26,
        rows: Number(body.rows) || 0,
        cells: body.cells && typeof body.cells === 'object' ? body.cells : {},
        readOnly: body.readOnly === true,
        tabs: Array.isArray(body.tabs) ? body.tabs : undefined,
        activeTab: typeof body.activeTab === 'string' ? body.activeTab : undefined,
    };
}

/** Save cells ("" clears one). At most MAX_CELLS_PER_REQUEST per call. */
export async function patchSheet(id: string, cells: Record<string, string>, tabId?: string): Promise<Record<string, string>> {
    const res = await authFetch(sheetUrl(id) + tabQuery(tabId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells }),
    });
    const body = await asJson<{ cells?: Record<string, string> }>(res, 'Failed to save the spreadsheet');
    return body.cells || {};
}

export async function createSheetTab(id: string, name?: string): Promise<{ tab: SheetTab; tabs: SheetTab[] }> {
    const res = await authFetch(sheetUrl(id, '/tabs'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name || undefined }),
    });
    return asJson<{ tab: SheetTab; tabs: SheetTab[] }>(res, 'Failed to create a tab');
}

export async function renameSheetTab(id: string, tabId: string, name: string): Promise<{ tabs: SheetTab[] }> {
    const res = await authFetch(sheetUrl(id, `/tabs/${encodeURIComponent(tabId)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    return asJson<{ tabs: SheetTab[] }>(res, 'Failed to rename the tab');
}

export async function deleteSheetTab(id: string, tabId: string): Promise<{ tabs: SheetTab[] }> {
    const res = await authFetch(sheetUrl(id, `/tabs/${encodeURIComponent(tabId)}`), { method: 'DELETE' });
    return asJson<{ tabs: SheetTab[] }>(res, 'Failed to delete the tab');
}

export function sheetCsvUrl(id: string, tabId?: string): string {
    return sheetUrl(id, '.csv') + tabQuery(tabId);
}

/** The computed values as a .csv file, through the signed-in session. */
export async function downloadSheetCsv(id: string, name?: string, tabId?: string): Promise<void> {
    const res = await authFetch(sheetCsvUrl(id, tabId));
    if (!res.ok) await asJson(res, 'Failed to download the CSV');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${(name || 'spreadsheet').replace(/[\\/:*?"<>|]+/g, '_').trim() || 'spreadsheet'}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
