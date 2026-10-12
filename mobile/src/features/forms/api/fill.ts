/**
 * Filling a form in, natively — the calls the web's PublicFormPage.jsx makes
 * (server/routes/automation/formPublic.js, under /api/automation/form).
 *
 * Forms are signed-in only (PUBLIC_FORMS_ENABLED is off), so every call here
 * carries the session like any other; a form the caller may not open answers
 * 404 exactly like one that does not exist, and the screen says "not
 * available" for both. The token is the form's credential: it is passed to
 * these calls and to nothing else.
 *
 * None of the writes retry. A submit that timed out may have landed — the
 * nonce makes a deliberate second tap safe, an automatic retry is not needed.
 */

import { api } from '@/core/api/client';
import { shareServerFile } from '@/core/api/shareFile';

import { readFillAck, readFillSession, readFillStart, readNotebookId, readPickResults } from './fillReaders';
import type { FillAck, FillSession, FillStart, PickResults } from '../model/fillTypes';

const base = (token: string) => `/api/automation/form/${encodeURIComponent(token)}`;
const sessionPath = (token: string, sid: string) => `${base(token)}/s/${encodeURIComponent(sid)}`;

/** Page one: its fields and theme, whether more pages may follow, and a CSRF token bound to this form. */
export async function getFillForm(token: string, signal?: AbortSignal): Promise<FillStart> {
    return readFillStart(await api.get<unknown>(base(token), { signal, retry: false }));
}

/**
 * Send one page's answers: page one to the form, a later page to its session.
 * A 400 carries `fields: [{ field, message }]` on the error's body.
 */
export async function submitFillPage(token: string, sessionId: string | null, body: Record<string, unknown>): Promise<FillAck> {
    const path = sessionId ? sessionPath(token, sessionId) : base(token);
    return readFillAck(await api.post<unknown>(path, body, { retry: false }));
}

/** Where the journey is; `null` when the session is gone (404) or the poll did not get through. */
export async function getFillSession(token: string, sid: string, signal?: AbortSignal): Promise<FillSession | null> {
    try {
        return readFillSession(await api.get<unknown>(sessionPath(token, sid), { signal, retry: false }));
    } catch {
        // A dropped poll is not fatal — the automation keeps going either way.
        return null;
    }
}

/**
 * An `app_pick` question's search. The phone sends a FIELD NAME and a term —
 * never an app or a tool; which app that means, and whether this person may
 * search it, the server answers from the declaration.
 */
export async function searchPickRecords(
    token: string,
    body: { field: string; query: string; csrf: string; sessionId: string | null },
    signal?: AbortSignal,
): Promise<PickResults> {
    const payload = { field: body.field, query: body.query, csrf: body.csrf, ...(body.sessionId ? { sessionId: body.sessionId } : {}) };
    return readPickResults(await api.post<unknown>(`${base(token)}/pick`, payload, { signal, retry: false }));
}

/** A document this journey produced: fetched with the session, handed to the share sheet. */
export async function shareFillFile(token: string, sid: string, file: { fileId: string; filename: string; mimeType: string }): Promise<void> {
    const path = `${sessionPath(token, sid)}/file/${encodeURIComponent(file.fileId)}`;
    await shareServerFile(path, file.filename || 'document', file.mimeType || 'application/octet-stream');
}

/** "Open in Notebooks": the server copies the document into a new notebook and names it. */
export async function openFileInNotebooks(token: string, sid: string, fileId: string): Promise<string | null> {
    const res = await api.post<unknown>(`${sessionPath(token, sid)}/file/${encodeURIComponent(fileId)}/notebook`, undefined, { retry: false });
    return readNotebookId(res);
}

/** "Save to Notebook": the closing page's own text, as a new notebook. */
export async function saveEndingToNotebook(token: string, sid: string, text: string, title: string): Promise<string | null> {
    return readNotebookId(await api.post<unknown>(`${sessionPath(token, sid)}/notebook`, { text, title }, { retry: false }));
}

export { uploadFillFile } from './fillUpload';
