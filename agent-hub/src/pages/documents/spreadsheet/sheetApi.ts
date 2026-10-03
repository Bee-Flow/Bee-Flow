// Client for /api/studio-documents/:id/sheet (the cells of a spreadsheet document).
// `/api` is part of the path, not of API_BASE (see documentsApi.js).

import { API_BASE, authFetch } from '../../../utils/helpers';

const BASE = `${API_BASE}/api/studio-documents`;

export interface SheetData {
    columns: number;
    /** The number of rows in use. */
    rows: number;
    /** Raw text per cell name: "12", "hello", "=SUM(A1:A5)". */
    cells: Record<string, string>;
    readOnly: boolean;
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

async function asJson<T>(res: Response, fallback: string): Promise<T> {
    let body: any = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) throw new SheetApiError((body && body.error) || fallback, res.status, body?.code);
    if (body === null) throw new SheetApiError(fallback, res.status, 'not_json');
    return body as T;
}

export async function getSheet(id: string): Promise<SheetData> {
    const res = await authFetch(sheetUrl(id));
    const body = await asJson<Partial<SheetData>>(res, 'Failed to load the spreadsheet');
    return {
        columns: Number(body.columns) || 26,
        rows: Number(body.rows) || 0,
        cells: body.cells && typeof body.cells === 'object' ? body.cells : {},
        readOnly: body.readOnly === true,
    };
}

/** Save cells ("" clears one). At most MAX_CELLS_PER_REQUEST per call. */
export async function patchSheet(id: string, cells: Record<string, string>): Promise<Record<string, string>> {
    const res = await authFetch(sheetUrl(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cells }),
    });
    const body = await asJson<{ cells?: Record<string, string> }>(res, 'Failed to save the spreadsheet');
    return body.cells || {};
}

export function sheetCsvUrl(id: string): string {
    return sheetUrl(id, '.csv');
}

/** The computed values as a .csv file, through the signed-in session. */
export async function downloadSheetCsv(id: string, name?: string): Promise<void> {
    const res = await authFetch(sheetCsvUrl(id));
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
