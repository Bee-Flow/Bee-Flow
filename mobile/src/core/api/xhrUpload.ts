/**
 * What an XMLHttpRequest upload needs from the client, and the one multipart
 * uploader every feature shares.
 *
 * The uploads a person watches (features/recording/api/upload.ts for meeting audio,
 * the Library's documents, a form's file question) cannot go through `request()`:
 * only XHR reports upload progress. They used to set their own two headers,
 * and so never sent `X-Session-Token` — and an SSO user has no cookie (see
 * setSessionToken in client.ts), so every one of their uploads was a 401.
 * setAuthHeaders and uploadError are the parts of `request()` an XHR has to do
 * by hand; uploadFile is the rest of it, so a feature declares an UploadTarget
 * and never builds an XMLHttpRequest itself.
 *
 * XMLHttpRequest is what gives us `upload.onprogress`. On Android it runs on
 * React Native's own OkHttp client, which shares the ForwardingCookieHandler
 * with `expo/fetch` (see the note at the top of client.ts), so the session
 * cookie travels here exactly as it does on every other request. It also
 * streams from disk when the part is `{ uri, name, type }`, so a large file
 * never has to exist in JS memory.
 */

import { translate } from '@/core/i18n';

import { ApiError, apiErrorFromBody, authHeaders, notifyUnauthorized } from './client';
import { apiUrl } from './server';

/** Set the headers every Bee Flow request carries. Call between open() and send(). */
export function setAuthHeaders(xhr: XMLHttpRequest): void {
    for (const [name, value] of Object.entries(authHeaders({ Accept: 'application/json' }))) {
        xhr.setRequestHeader(name, value);
    }
}

/**
 * The ApiError for an upload the server answered but did not accept, from its
 * status and parsed body (`null` when that was not JSON). A 401 reaches the
 * auth layer here too, so an expired session brings up the lock screen rather
 * than a failed upload with nothing to do about it.
 */
export function uploadError(path: string, status: number, body: unknown): ApiError {
    if (status === 401) notifyUnauthorized(path);
    // A load event with status 0 is a connection that closed before answering.
    return apiErrorFromBody(status, body, status === 0 ? 'The upload was interrupted.' : undefined);
}

export interface UploadTarget {
    /** Full client path, including the mount prefix. */
    path: string;
    /** The multer field name. Wrong name → 400 "No file uploaded". */
    field: string;
    /** Server-side `limits.fileSize`. Checked here so the bytes never leave. */
    maxBytes: number;
    /** Extra multipart text fields, read straight off `req.body`. */
    extra?: Record<string, string>;
    /** Human hint for the picker and the too-large message. */
    accepts?: string;
}

export interface UploadFile {
    uri: string;
    name: string;
    mimeType: string;
    /** From the picker. 0 when unknown — the cap check then falls to the server. */
    size: number;
}

export interface UploadProgress {
    loaded: number;
    total: number;
    /** 0..1, clamped. 0 while the total is still unknown. */
    fraction: number;
}

export class FileTooLargeError extends ApiError {
    constructor(name: string, maxBytes: number) {
        super(`${name} is larger than ${Math.round(maxBytes / (1024 * 1024))} MB, which is the limit for this upload.`);
        this.name = 'FileTooLargeError';
    }
}

function parseBody(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        // A non-JSON body falls through to the status-based message.
        return null;
    }
}

function formFor(target: UploadTarget, file: UploadFile): FormData {
    const form = new FormData();
    // React Native's FormData takes a file descriptor object here; the DOM
    // typings only know about Blob, hence the cast.
    form.append(target.field, { uri: file.uri, name: file.name, type: file.mimeType } as unknown as Blob);
    for (const [key, value] of Object.entries(target.extra ?? {})) form.append(key, value);
    return form;
}

const cancelled = () => new ApiError(translate('mobile.upload.cancelled', 'Upload cancelled.'));

/**
 * POST one file. Resolves with the parsed JSON body.
 *
 * Deliberately never retried: re-sending 40 MB because the first attempt timed
 * out burns a data plan, and every caller has a visible Retry the person can
 * press when they want that.
 */
export function uploadFile<T>(
    target: UploadTarget,
    file: UploadFile,
    opts: { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal } = {},
): Promise<T> {
    const { onProgress, signal } = opts;
    return new Promise<T>((resolve, reject) => {
        if (file.size > 0 && file.size > target.maxBytes) {
            reject(new FileTooLargeError(file.name, target.maxBytes));
            return;
        }
        if (signal?.aborted) {
            reject(cancelled());
            return;
        }

        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl(target.path));
        xhr.responseType = 'text';
        xhr.withCredentials = true;
        setAuthHeaders(xhr);
        // No timeout: the deadline that matters is the person's patience, and
        // they have Cancel. A fixed one would kill an upload making progress.
        xhr.timeout = 0;

        const onAbort = () => xhr.abort();
        signal?.addEventListener('abort', onAbort);
        const cleanup = () => signal?.removeEventListener('abort', onAbort);

        if (onProgress) {
            xhr.upload.onprogress = (event: ProgressEvent) => {
                const total = event.lengthComputable ? event.total : 0;
                onProgress({ loaded: event.loaded, total, fraction: total > 0 ? Math.min(1, event.loaded / total) : 0 });
            };
        }
        xhr.onload = () => {
            cleanup();
            const parsed = parseBody(xhr.responseText);
            if (xhr.status >= 200 && xhr.status < 300) resolve(parsed as T);
            else reject(uploadError(target.path, xhr.status, parsed));
        };
        // Status 0 with no body is a dropped connection. Say that: the file is
        // still on the device and retrying is the only correct next step.
        xhr.onerror = () => {
            cleanup();
            reject(new ApiError(translate('mobile.upload.dropped', 'The connection dropped during the upload. The file is still on this device.')));
        };
        xhr.onabort = () => {
            cleanup();
            reject(cancelled());
        };
        xhr.send(formFor(target, file));
    });
}
