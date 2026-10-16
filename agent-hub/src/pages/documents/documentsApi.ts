import { API_BASE, authFetch } from '../../utils/helpers';
import type { Folder, LibraryRow, People, StudioDocument } from './documentQueries';
import type { DeckTheme } from './DeckPreview';

/** The error every call here throws: the status and the server's `code`, plus what a refused save carries. */
export interface DocumentsApiError extends Error {
    status?: number;
    code?: string | null;
    conflict?: unknown;
    conflictVersionId?: string;
}

/** What the server puts in a non-2xx body. */
interface ErrorBody { error?: string; code?: string; conflict?: unknown; conflictVersionId?: string }

/** Filters for the library lists; sent as the query string. */
type QueryFilters = Record<string, string>;


/**
 * Client for /api/studio-documents.
 *
 * The prefix is `studio-documents`, not `documents`: that one belongs to the
 * legacy mobile "Generated PDFs" lister (server/routes/documents.js), whose
 * `/list` a `/:id` route here would swallow. See the header of
 * server/routes/studioDocuments.js.
 */
// `/api` is part of the path, NOT of API_BASE. In a production build API_BASE
// is the EMPTY STRING (relative URLs behind the nginx proxy), so omitting it
// here resolved to `/studio-documents`, which the SPA catch-all answered with
// index.html and a 200 — `res.json()` then threw and every call died with
// "Cannot read properties of null". Dev hid it completely: there API_BASE is
// `http://host:3001`, which 404s loudly. Every other API module in this app
// writes `${API_BASE}/api/...` for exactly this reason.
const BASE = `${API_BASE}/api/studio-documents`;

type RenderFormat = 'pdf' | 'pptx';

interface DocumentsPageBody {
    documents?: LibraryRow[];
    total?: unknown;
    people?: People;
    notebooks?: unknown;
    spreadsheets?: unknown;
}

/** A document with the placeholders it carries (what the pickers list). */
export type DocumentTemplate = LibraryRow & { placeholders?: unknown[]; folder?: Folder };

/** The answer to a presence heartbeat: who else is here. */
type PresenceAnswer = { peers?: unknown; people?: People; ttlMs?: unknown };

/** The letterhead and whether this user may save it. */
type HouseStyleAnswer = { style?: Record<string, unknown> | null; editable?: boolean } & Record<string, unknown>;

async function asJson<T>(res: Response, fallback: string): Promise<T> {
    let body: (T & ErrorBody) | null = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
        const err: DocumentsApiError = new Error((body && body.error) || fallback);
        err.status = res.status;
        err.code = body && body.code;
        // A stale save the server could not merge: the parts to compare.
        if (body && body.conflict) err.conflict = body.conflict;
        // A page that went live meanwhile: the version that keeps the refused text.
        if (body && body.conflictVersionId) err.conflictVersionId = body.conflictVersionId;
        throw err;
    }
    // A 2xx whose body will not parse is not "no data" — it is the wrong
    // endpoint answering. Returning null here let every caller die on
    // `body.document` with "Cannot read properties of null", which says
    // nothing about the URL being wrong. Say what actually happened.
    if (body === null) {
        const err: DocumentsApiError = new Error(`${fallback} — the server answered ${res.status} with a body that is not JSON.`);
        err.status = res.status;
        err.code = 'not_json';
        throw err;
    }
    return body;
}

/**
 * One page of the library with the total and the names of the people on it
 * (owner, last editor). `archived: '1'` lists the caller's archive.
 */
export async function listDocumentsPage(filters: Record<string, string | number | undefined | null> = {}) {
    const query = new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== undefined && v !== null && v !== '') as [string, string][]);
    const res = await authFetch(query.size ? `${BASE}?${query}` : BASE);
    const body = await asJson<DocumentsPageBody>(res, 'Failed to load documents');
    // `notebooks` / `spreadsheets`: whether this reader may have (and start) them.
    return {
        documents: body.documents || [], total: Number(body.total) || 0, people: body.people || {},
        notebooks: body.notebooks === true, spreadsheets: body.spreadsheets === true,
    };
}

/** Start a spreadsheet: the server makes the table for its cells, then the document. */
export async function createSpreadsheet({ name, folderId }: { name?: string; folderId?: string | null } = {}) {
    const res = await authFetch(`${BASE}/sheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...(folderId ? { folderId } : {}) }),
    });
    return (await asJson<{ document: StudioDocument }>(res, 'The spreadsheet could not be started')).document;
}

export async function listDocuments(filters: Record<string, string | undefined | null> = {}) {
    const query = new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== undefined && v !== null) as [string, string][]);
    const res = await authFetch(query.size ? `${BASE}?${query}` : BASE);
    const body = await asJson<{ documents?: LibraryRow[] }>(res, 'Failed to load documents');
    return body.documents || [];
}

/**
 * The caller's documents WITH the placeholders each one carries.
 *
 * What the automation step's and the app action's document pickers list: a name
 * alone does not tell an author which values a template wants, and asking them
 * to open the document in another tab to find out is how a value ends up bound
 * to a placeholder that does not exist.
 */
export async function listTemplates(filters: QueryFilters = {}) {
    const query = new URLSearchParams(filters);
    const res = await authFetch(`${BASE}/templates${query.size ? `?${query}` : ''}`);
    const body = await asJson<{ templates?: DocumentTemplate[] }>(res, 'Failed to load document templates');
    return body.templates || [];
}

export async function getDocument(id: string) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`);
    const body = await asJson<{ document: StudioDocument }>(res, 'Failed to load document');
    return body.document;
}

/** A document with the names of its owner and last editor. */
export async function getDocumentView(id: string) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`);
    const body = await asJson<{ document: StudioDocument; people?: People }>(res, 'Failed to load document');
    return { document: body.document, people: body.people || {} };
}

export async function createDocument(input: object = {}) {
    const res = await authFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const body = await asJson<{ document: StudioDocument }>(res, 'Failed to create document');
    return body.document;
}

export async function updateDocument(id: string, patch: Record<string, unknown>) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const body = await asJson<{ document: StudioDocument }>(res, 'Failed to save document');
    return body.document;
}

export async function deleteDocument(id: string) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await asJson<unknown>(res, 'Failed to delete document');
    return true;
}

/** Back from the archive (the owner). */
export async function unarchiveDocument(id: string) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/unarchive`, { method: 'POST' });
    const body = await asJson<{ document: StudioDocument }>(res, 'Failed to restore the document');
    return body.document;
}

/**
 * The editor's heartbeat: where this editor is, answered with who else is
 * here. `state: 'left'` ends it.
 */
export async function postPresence(id: string, beat: Record<string, unknown>) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/presence`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(beat),
    });
    return asJson<PresenceAnswer>(res, 'Presence failed');
}

/** The composed preview (sanitised by the server) as text, for the canvas. */
export async function fetchPreviewHtml(id: string, { signal }: { signal?: AbortSignal } = {}) {
    const res = await authFetch(previewUrl(id, { edit: true }), { signal });
    if (!res.ok) {
        const err: DocumentsApiError = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
    }
    return res.text();
}

/** The URL the editor's iframe loads. `edit` asks for the hand-editing bridge. */
export function previewUrl(id: string, { edit = false }: { edit?: boolean } = {}) {
    return `${BASE}/${encodeURIComponent(id)}/preview${edit ? '?edit=1' : ''}`;
}

/**
 * A presentation as it WOULD look with unsaved edits: the outline being typed,
 * the look being chosen. The server renders it (the same viewer the saved
 * preview uses) and stores nothing, so the editor can show every change live
 * without minting a version per keystroke.
 */
export async function previewDeckDraft(id: string, draft: Record<string, unknown> | null | undefined, { signal }: { signal?: AbortSignal } = {}) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft || {}),
        signal,
    });
    if (!res.ok) {
        let body: ErrorBody | null = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        const err: DocumentsApiError = new Error((body && body.error) || 'Could not render the presentation');
        err.status = res.status;
        err.code = body && body.code;
        throw err;
    }
    return res.text();
}

/**
 * Download the PDF.
 *
 * Fetched rather than linked because the endpoint needs the auth header that
 * authFetch attaches — a bare <a href> would arrive unauthenticated and get a
 * 401 page where the user expected a file. The blob is handed to a synthetic
 * anchor and the object URL revoked straight after, so nothing leaks.
 *
 * Returns { degraded } so the caller can say why the PDF looks plainer than
 * the screen when the pwt-runner container is absent and the server fell back
 * to pdfkit.
 */
export async function downloadPdf(id: string, name: string | undefined, versionId?: string | null) {
    return downloadRendered(id, name, versionId, 'pdf');
}

/** A presentation as a real PowerPoint file — the same fetch-then-anchor path as the PDF. */
export async function downloadPptx(id: string, name: string | undefined, versionId?: string | null) {
    return downloadRendered(id, name, versionId, 'pptx');
}

/** The rendered file as a Blob (PDF, or a presentation's .pptx). */
export async function fetchRendered(id: string, versionId?: string | null, format: RenderFormat = 'pdf') {
    const revision = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/${format}${revision}`);
    if (!res.ok) {
        let body: ErrorBody | null = null;
        try { body = await res.json(); } catch { /* the error body may be bytes */ }
        const err: DocumentsApiError = new Error((body && body.error) || (format === 'pptx' ? 'Failed to build the presentation' : 'Failed to render the PDF'));
        err.status = res.status;
        err.code = body && body.code;
        throw err;
    }
    return { blob: await res.blob(), degraded: res.headers.get('X-Document-Degraded') === '1' };
}

async function downloadRendered(id: string, name: string | undefined, versionId: string | null | undefined, format: RenderFormat) {
    const { blob, degraded } = await fetchRendered(id, versionId, format);
    const url = URL.createObjectURL(blob);
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `${(name || 'document').replace(/[^\w\s.-]/g, '').trim() || 'document'}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
    } finally {
        // Give the click a tick to start before the URL stops resolving.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return { degraded };
}

// ── House style ──────────────────────────────────────────────────────

/**
 * The organisation's letterhead. Readable by any signed-in user (the editor
 * needs to know whether one exists); `editable` in the response says whether
 * this user may PUT it, so the form can render read-only instead of offering a
 * Save that will 403.
 */
export async function getHouseStyle() {
    const res = await authFetch(`${BASE}/house-style`);
    return asJson<HouseStyleAnswer>(res, 'Failed to load the house style');
}

/** The resolved deck theme for an (unsaved) style — what the presentation preview draws. */
export async function previewDeckTheme(style: Record<string, unknown>, overrides: Record<string, unknown> | null = null) {
    const res = await authFetch(`${BASE}/house-style/preview-theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, overrides }),
    });
    const body = await asJson<{ theme: DeckTheme }>(res, 'Failed to preview the presentation style');
    return body.theme;
}

export async function saveHouseStyle(style: Record<string, unknown>) {
    const res = await authFetch(`${BASE}/house-style`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(style),
    });
    const body = await asJson<{ style: Record<string, unknown> }>(res, 'Failed to save the house style');
    return body.style;
}

/**
 * Read a File into a data: URL.
 *
 * The logo has to travel as BYTES, not as a URL: the composer strips every
 * remote url() because the PDF renders in a real Chromium on the server, where
 * a fetch is an SSRF primitive and a privacy leak.
 */
export function fileToDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
    });
}

export async function documentRequest(path: string, data?: unknown, method?: string) {
    const res = await authFetch(`${BASE}${path}`, {
        method: method || (data === undefined ? 'GET' : 'POST'),
        ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
    return asJson<unknown>(res, 'Document request failed');
}

/** A .pptx → the template look the deck engine can reuse (stored under deck.template on save). */
export async function uploadDeckTemplate(dataUrl: string, name = '') {
    const res = await authFetch(`${BASE}/house-style/deck-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, name }),
    });
    const body = await asJson<{ template: Record<string, unknown> }>(res, 'Failed to read the template deck');
    return body.template;
}
