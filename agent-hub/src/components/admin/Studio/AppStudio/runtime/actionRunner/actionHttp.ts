/**
 * The runner's HTTP calls, in one place: the v1 /run POST and its poll, the
 * /step and /step/stream POSTs, and an attachment download. The callers own
 * what a status or a body means; this module only speaks to the server.
 */
import { API_BASE, authFetch } from '../../../../../../utils/helpers';

/** The base URL of one app's action routes. */
export function actionsUrl(appId: string): string {
    return `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/actions`;
}

/** A JSON POST; `deadlineMs` aborts it with a TimeoutError when given. */
export function postJson(url: string, body: unknown, deadlineMs?: number): Promise<Response> {
    return authFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        ...(deadlineMs ? { signal: AbortSignal.timeout(deadlineMs) } : {}),
    });
}

/** A plain authenticated GET (a run's state, an attachment's bytes). */
export function getAuthed(url: string): Promise<Response> {
    return authFetch(url);
}

/** The attachment route a download_file step reads, so the viewer's access is checked. */
export function attachmentUrl(appId: string, fileId: string): string {
    return `${API_BASE}/api/studio-apps/${encodeURIComponent(appId)}/data/attachments/${encodeURIComponent(fileId)}`;
}
