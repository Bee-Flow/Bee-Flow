/**
 * notebookApi.js — shared HTTP helpers for the Notebooks + Legal surfaces.
 *
 * Extracted from NotebooksPage so the page and the V2 workspace
 * hooks all hit the `/api/notebooks/*` endpoints through one definition instead
 * of copy-pasting the fetch+error-handling boilerplate. Both surfaces use the
 * notebook endpoints for sources / generation / export / document-save (Legal
 * keeps its own `/api/legal-matters/*` calls for matter-specific data).
 */
import { API_BASE, authFetch } from '../utils/helpers';

/** Options for a notebook call: fetch's own, headers kept as a plain record. */
export interface NotebookApiOptions extends Omit<RequestInit, 'headers'> {
    headers?: Record<string, string>;
}

/** An Error carrying the HTTP status and the server's body/code. */
interface NotebookApiError extends Error {
    status?: number;
    body?: { error?: string; code?: string };
    code?: string | null;
}

/** GET/POST/PUT/DELETE against `/api/notebooks{path}`. `path === '/'` lists. */
export async function notebookApi(path: string, opts: NotebookApiOptions = {}) {
    const url = `${API_BASE}/api/notebooks${path === '/' ? '' : path}`;
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts,
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error('[Notebooks] API error:', res.status, data);
        const err: NotebookApiError = new Error(data.error || `API ${res.status}`);
        err.status = res.status;
        // The server's code and details (a 409 says WHICH conflict it is, and
        // which version kept the losing copy).
        err.body = data;
        err.code = data.code || null;
        throw err;
    }
    return res.json();
}

/** Multipart upload of a single source file to a notebook/matter. */
export async function uploadSourceFile(entityId: string, file: File | Blob) {
    const form = new FormData();
    form.append('file', file);
    const res = await authFetch(`${API_BASE}/api/notebooks/${entityId}/sources/file`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        // The server's own sentence (too large, not a supported type) is what
        // the upload row should say.
        const data = await res.json().catch(() => ({}));
        const err: NotebookApiError = new Error(data.error || `Upload failed (${res.status})`);
        err.status = res.status;
        throw err;
    }
    return res.json();
}

/** Extracted text of a source (preview panel). */
export function getSourceContent(entityId: string | null | undefined, sid: string) {
    return notebookApi(`/${entityId}/sources/${sid}/content`);
}

/** Rename a source. */
export function renameSource(entityId: string, sid: string, name: string) {
    return notebookApi(`/${entityId}/sources/${sid}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

/** Persist a manual source ordering. */
export function reorderSourcesApi(entityId: string, orderedIds: string[]) {
    return notebookApi(`/${entityId}/sources/reorder`, { method: 'PATCH', body: JSON.stringify({ orderedIds }) });
}

/** Delete several sources at once. */
export function bulkDeleteSourcesApi(entityId: string, ids: string[]) {
    return notebookApi(`/${entityId}/sources/bulk-delete`, { method: 'POST', body: JSON.stringify({ ids }) });
}
