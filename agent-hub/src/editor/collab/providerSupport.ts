/**
 * providerSupport.ts — the pure parts of the co-editing provider: its types and
 * tuning, how a failed request is classified, whether an update carries
 * anything, and how work is deferred to the next animation frame.
 */
import * as Y from 'yjs';

export type CollabStatus = 'connecting' | 'synced' | 'offline' | 'error' | 'disabled' | 'readonly';
export type CollabKind = 'notebook' | 'document';

/** Transaction origin of everything that came from the server. */
export const REMOTE_ORIGIN: { readonly source: 'collab-remote' } = Object.freeze({ source: 'collab-remote' });

/** Minimal HTTP seam; the default wraps apiClient. Throws with `status` and `body.code`. */
export interface CollabHttp {
    post<T = unknown>(path: string, body: unknown): Promise<T | null>;
    /** A POST that outlives the page (fetch keepalive), for the last edits when it closes. */
    beacon?(path: string, body: unknown): void;
}

export interface CollabProviderOptions {
    projectId: string;
    kind: CollabKind;
    resourceId: string;
    userId: string;
    http: CollabHttp;
    /** Run `fn` on the next frame; returns a cancel function. */
    scheduleFrame?: (fn: () => void) => () => void;
    batchMs?: number;
    onWarn?: (message: string) => void;
}

/** Tuning: batch window, retry cap, presence throttle, offline grace, polling sync. */
export const BATCH_MS = 200;
export const MAX_RETRY_MS = 30_000;
export const AWARENESS_MS = 250;
export const OFFLINE_GRACE_MS = 3_000;
export const POLL_SYNC_MS = 5_000;

interface HttpErrorLike { status?: number; body?: { code?: string } | null }

/** Status and server code of a failed request (see api/client ApiError). */
export function errorOf(e: unknown): { status: number; code: string } {
    const err = (e || {}) as HttpErrorLike;
    const status = typeof err.status === 'number' ? err.status : 0;
    const code = err.body && typeof err.body.code === 'string' ? err.body.code : '';
    return { status, code };
}

/** Failures worth retrying: network, timeouts, rate limits and server errors. */
export const retryable = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500;

/** A readable code for a failed request: the server's, else the status. */
export const codeOf = (status: number, code: string, fallback?: string) => code || fallback || (status ? `HTTP_${status}` : 'NETWORK');

/**
 * What a failed join (or first sync) means: try again later (a network error,
 * a rate limit, a busy server), co-editing switched off for this item (the
 * caller falls back to its own save path), or an error that ends the session.
 */
export type JoinFailure = { retry: true } | { retry: false; final: 'error' | 'disabled'; code: string };

/** 503s that mean "not co-edited" rather than "not right now". */
const FALLBACK_CODES = new Set(['COLLAB_UNSUPPORTED', 'COLLAB_DISABLED', 'COLLAB_UNAVAILABLE']);

export function joinFailure(status: number, code: string): JoinFailure {
    if (FALLBACK_CODES.has(code)) return { retry: false, final: 'disabled', code };
    if (status === 404) return { retry: false, final: 'error', code: codeOf(status, code, 'NOT_FOUND') };
    if (status === 403) return { retry: false, final: 'error', code: codeOf(status, code, 'FORBIDDEN') };
    if (retryable(status)) return { retry: true };
    return { retry: false, final: 'error', code: codeOf(status, code) };
}

export interface SyncResponse { update?: string; sv?: string; seq?: number; canEdit?: boolean }

/** Whether an update adds or deletes anything (an empty diff is not sent). */
export function hasContent(update: Uint8Array): boolean {
    try {
        const { structs, ds } = Y.decodeUpdate(update);
        return structs.length > 0 || ds.clients.size > 0;
    } catch {
        return false;
    }
}

/** Run `fn` on the next frame (a timer while the tab is hidden); returns a cancel function. */
export function defaultScheduleFrame(fn: () => void): () => void {
    if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined' && !document.hidden) {
        const id = requestAnimationFrame(() => fn());
        return () => cancelAnimationFrame(id);
    }
    const t = setTimeout(fn, 16);
    return () => clearTimeout(t);
}
