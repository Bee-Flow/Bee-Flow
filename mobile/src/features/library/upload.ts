/**
 * Multipart upload, with a number attached to it.
 *
 * `api.upload` is the right tool for a small one-shot form, but it cannot
 * report progress, and every upload in the Library is one a person watches:
 * a 40-page PDF on hotel wifi, a photographed contract, a .docx template. A
 * spinner with no number is indistinguishable from a hang, and the honest
 * answer to "is this stuck?" is a percentage.
 *
 * XMLHttpRequest is what gives us `upload.onprogress`. On Android it runs on
 * React Native's own OkHttp client, which shares the ForwardingCookieHandler
 * with `expo/fetch` (see the note at the top of src/api/client.ts), so the
 * session cookie travels here exactly as it does on every other request. It
 * also streams from disk when the part is `{ uri, name, type }`, so a large
 * file never has to exist in JS memory. This mirrors uploadRecording() in
 * src/features/recording/api.ts, which solved the same problem for audio.
 *
 * THE FIELD NAMES AND CAPS BELOW ARE THE CONTRACT. Each one is a multer
 * `upload.single(...)` on the server and a `limits.fileSize` next to it; a
 * mismatch is a 400 "No file uploaded" that looks like a network fault.
 */

import { ApiError } from '../../api/client';
import { apiUrl } from '../../api/server';

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

/** routes/notebooks.js — `upload.single('file')`, 50 MB. */
export function notebookSourceTarget(notebookId: string): UploadTarget {
    return {
        path: `/api/notebooks/${encodeURIComponent(notebookId)}/sources/file`,
        field: 'file',
        maxBytes: 50 * 1024 * 1024,
        accepts: 'PDF, Word, Excel, CSV, text or an image',
    };
}

/** routes/knowledgeBases/ingest.js — `upload.single('file')`, 20 MB. */
export function kbIngestTarget(kbId: string): UploadTarget {
    return {
        path: `/api/kb/${encodeURIComponent(kbId)}/ingest/file`,
        field: 'file',
        maxBytes: 20 * 1024 * 1024,
        accepts: 'PDF, Word, Excel, CSV or text',
    };
}

/**
 * routes/templates.js — `upload.single('file')`, 20 MB, and the route rejects
 * anything whose name does not end in .docx before it looks at the bytes.
 */
export function templateUploadTarget(extra?: Record<string, string>): UploadTarget {
    return {
        path: '/api/templates/upload',
        field: 'file',
        maxBytes: 20 * 1024 * 1024,
        accepts: 'a Word .docx file',
        ...(extra ? { extra } : {}),
    };
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

/**
 * POST one file. Resolves with the parsed JSON body.
 *
 * Deliberately never retried: re-sending 40 MB because the first attempt timed
 * out burns a data plan, and every caller here has a visible Retry button that
 * the person can press when they want that.
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
            reject(new ApiError('Upload cancelled.'));
            return;
        }

        const form = new FormData();
        // React Native's FormData takes a file descriptor object here; the DOM
        // typings only know about Blob, hence the cast.
        form.append(target.field, {
            uri: file.uri,
            name: file.name,
            type: file.mimeType,
        } as unknown as Blob);
        for (const [key, value] of Object.entries(target.extra ?? {})) form.append(key, value);

        const xhr = new XMLHttpRequest();
        xhr.open('POST', apiUrl(target.path));
        xhr.responseType = 'text';
        xhr.withCredentials = true;
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('X-Beeflow-Client', 'android');
        // No timeout: the deadline that matters is the person's patience, and
        // they have Cancel. A fixed one would kill an upload making progress.
        xhr.timeout = 0;

        const onAbort = () => xhr.abort();
        signal?.addEventListener('abort', onAbort);
        const cleanup = () => signal?.removeEventListener('abort', onAbort);

        if (onProgress) {
            xhr.upload.onprogress = (event: ProgressEvent) => {
                const total = event.lengthComputable ? event.total : 0;
                onProgress({
                    loaded: event.loaded,
                    total,
                    fraction: total > 0 ? Math.min(1, event.loaded / total) : 0,
                });
            };
        }

        xhr.onload = () => {
            cleanup();
            let parsed: unknown = null;
            try {
                parsed = JSON.parse(xhr.responseText) as unknown;
            } catch {
                /* a non-JSON body falls through to the status-based message */
            }
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve(parsed as T);
                return;
            }
            const message =
                (parsed as { error?: string } | null)?.error ||
                (xhr.status === 0 ? 'The upload was interrupted.' : `HTTP ${xhr.status}`);
            reject(new ApiError(message, { status: xhr.status, body: parsed }));
        };

        xhr.onerror = () => {
            cleanup();
            // status 0 with no body is a dropped connection. Say that: the file
            // is still on the device and retrying is the only correct next step.
            reject(new ApiError('The connection dropped during the upload. The file is still on this device.'));
        };

        xhr.onabort = () => {
            cleanup();
            reject(new ApiError('Upload cancelled.'));
        };

        xhr.send(form);
    });
}

