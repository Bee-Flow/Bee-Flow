import { API_BASE, authFetch } from '../../utils/helpers';

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

async function asJson(res, fallback) {
    let body = null;
    try { body = await res.json(); } catch { /* empty or non-JSON body */ }
    if (!res.ok) {
        // A licence refusal (requireCapability) carries its reason in `error`
        // and no `code`: `feature_locked` or `feature_disabled`, plus the
        // `feature`. Those travel as the code, and the message becomes a
        // sentence, so no caller shows the bare token. The Documents pages
        // word it in the reader's language (./documentsLock.ts).
        const licence = body && res.status === 403 && /^feature_(locked|disabled)$/.test(body.error || '') ? body.error : null;
        const err = new Error(licence
            ? 'Making and changing documents is not included for you. You can still open, download and archive your documents.'
            : ((body && body.error) || fallback));
        err.status = res.status;
        err.code = (body && body.code) || licence || undefined;
        err.feature = body && body.feature;
        throw err;
    }
    // A 2xx whose body will not parse is not "no data" — it is the wrong
    // endpoint answering. Returning null here let every caller die on
    // `body.document` with "Cannot read properties of null", which says
    // nothing about the URL being wrong. Say what actually happened.
    if (body === null) {
        const err = new Error(`${fallback} — the server answered ${res.status} with a body that is not JSON.`);
        err.status = res.status;
        err.code = 'not_json';
        throw err;
    }
    return body;
}

export async function listDocuments(filters = {}) {
    const query = new URLSearchParams(Object.entries(filters).filter(([,v]) => v !== undefined && v !== null));
    const res = await authFetch(query.size ? `${BASE}?${query}` : BASE);
    const body = await asJson(res, 'Failed to load documents');
    return body.documents || [];
}

/**
 * The caller's documents WITH the placeholders each one carries.
 *
 * What the routine step's and the app action's document pickers list: a name
 * alone does not tell an author which values a template wants, and asking them
 * to open the document in another tab to find out is how a value ends up bound
 * to a placeholder that does not exist.
 */
export async function listTemplates(filters = {}) {
    const query = new URLSearchParams(filters);
    const res = await authFetch(`${BASE}/templates${query.size ? `?${query}` : ''}`);
    const body = await asJson(res, 'Failed to load document templates');
    return body.templates || [];
}

export async function getDocument(id) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`);
    const body = await asJson(res, 'Failed to load document');
    return body.document;
}

export async function createDocument(input = {}) {
    const res = await authFetch(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
    });
    const body = await asJson(res, 'Failed to create document');
    return body.document;
}

export async function updateDocument(id, patch) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const body = await asJson(res, 'Failed to save document');
    return body.document;
}

export async function deleteDocument(id) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await asJson(res, 'Failed to delete document');
    return true;
}

export async function listVersions(id) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/versions`);
    const body = await asJson(res, 'Failed to load history');
    return body.versions || [];
}

export async function restoreVersion(id, versionId, expectedVersionId) {
    const res = await authFetch(
        `${BASE}/${encodeURIComponent(id)}/versions/${encodeURIComponent(versionId)}/restore`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersionId }) },
    );
    const body = await asJson(res, 'Failed to restore that version');
    return body.document;
}

/** The URL the editor's iframe loads. `edit` asks for the hand-editing bridge. */
export function previewUrl(id, { edit = false } = {}) {
    return `${BASE}/${encodeURIComponent(id)}/preview${edit ? '?edit=1' : ''}`;
}

/**
 * A presentation as it WOULD look with unsaved edits: the outline being typed,
 * the look being chosen. The server renders it (the same viewer the saved
 * preview uses) and stores nothing, so the editor can show every change live
 * without minting a version per keystroke.
 */
export async function previewDeckDraft(id, draft, { signal } = {}) {
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(draft || {}),
        signal,
    });
    if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch { /* not JSON */ }
        const err = new Error((body && body.error) || 'Could not render the presentation');
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
export async function downloadPdf(id, name, versionId) {
    return downloadRendered(id, name, versionId, 'pdf');
}

/** A presentation as a real PowerPoint file — the same fetch-then-anchor path as the PDF. */
export async function downloadPptx(id, name, versionId) {
    return downloadRendered(id, name, versionId, 'pptx');
}

async function downloadRendered(id, name, versionId, format) {
    const revision = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
    const res = await authFetch(`${BASE}/${encodeURIComponent(id)}/${format}${revision}`);
    if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch { /* the error body may be bytes */ }
        const err = new Error((body && body.error) || (format === 'pptx' ? 'Failed to build the presentation' : 'Failed to render the PDF'));
        err.status = res.status;
        err.code = body && body.code;
        throw err;
    }
    const degraded = res.headers.get('X-Document-Degraded') === '1';
    const blob = await res.blob();
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
    return asJson(res, 'Failed to load the house style');
}

/** The resolved deck theme for an (unsaved) style — what the presentation preview draws. */
export async function previewDeckTheme(style, overrides = null) {
    const res = await authFetch(`${BASE}/house-style/preview-theme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ style, overrides }),
    });
    const body = await asJson(res, 'Failed to preview the presentation style');
    return body.theme;
}

export async function saveHouseStyle(style) {
    const res = await authFetch(`${BASE}/house-style`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(style),
    });
    const body = await asJson(res, 'Failed to save the house style');
    return body.style;
}

/**
 * Read a File into a data: URL.
 *
 * The logo has to travel as BYTES, not as a URL: the composer strips every
 * remote url() because the PDF renders in a real Chromium on the server, where
 * a fetch is an SSRF primitive and a privacy leak.
 */
export function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
    });
}

export async function documentRequest(path, data, method) {
    const res = await authFetch(`${BASE}${path}`, {
        method: method || (data === undefined ? 'GET' : 'POST'),
        ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }),
    });
    return asJson(res, 'Document request failed');
}

/** A .pptx → the template look the deck engine can reuse (stored under deck.template on save). */
export async function uploadDeckTemplate(dataUrl, name = '') {
    const res = await authFetch(`${BASE}/house-style/deck-template`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, name }),
    });
    const body = await asJson(res, 'Failed to read the template deck');
    return body.template;
}
