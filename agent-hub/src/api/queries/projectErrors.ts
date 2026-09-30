// How a refused /api/projects request reaches the screen.
//
// The server refuses with `{ error, code, details? }`: `error` is an English
// sentence, `code` a stable name (SHARED_CHATS_REMAIN, KIND_NOT_ALLOWED, …).
// The data layer keeps all three on the Error it throws, so the screen can say
// the refusal in the reader's language from the code
// (components/projects/workspace/projectErrorText.ts) and fall back to the
// server's sentence for a code it does not know.

import { ApiError } from '../client';

export interface ProjectErrorInit {
    status?: number | null;
    code?: string | null;
    details?: Record<string, unknown> | null;
    /** The sentence the server sent, when it sent one. */
    serverMessage?: string | null;
}

/**
 * A refused project request: its code and details, and the server's sentence
 * when there was one. `message` falls back to the caller's English sentence;
 * `serverMessage` stays null then, so the screen can put its own translated
 * fallback in its place.
 */
export class ProjectRequestError extends Error {
    readonly status: number | null;
    readonly code: string | null;
    readonly details: Record<string, unknown> | null;
    readonly serverMessage: string | null;
    constructor(message: string, { status = null, code = null, details = null, serverMessage = null }: ProjectErrorInit = {}) {
        super(message);
        this.name = 'ProjectRequestError';
        this.status = status;
        this.code = code;
        this.details = details;
        this.serverMessage = serverMessage;
    }
}

/** What a refusal says, wherever it came from. */
export interface ProjectErrorInfo {
    code: string | null;
    details: Record<string, unknown> | null;
    /** The server's sentence (or a foreign Error's message), if there is one. */
    message: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);

/** The `{ error, code, details }` body of a refusal, as the server sent it. */
function infoFromBody(body: unknown): ProjectErrorInfo {
    if (!isRecord(body)) return { code: null, details: null, message: null };
    return {
        code: text(body.code),
        details: isRecord(body.details) ? body.details : null,
        message: text(body.error),
    };
}

/**
 * Code, details and sentence of a refusal. Takes a thrown error (this
 * module's, or the API client's) or a raw response body, so callers that
 * still use fetch directly read refusals the same way.
 */
export function projectErrorInfo(source: unknown): ProjectErrorInfo {
    if (source instanceof ProjectRequestError) {
        return { code: source.code, details: source.details, message: text(source.serverMessage) };
    }
    if (source instanceof ApiError) {
        const fromBody = infoFromBody(source.body);
        return { ...fromBody, message: fromBody.message || text(source.message) };
    }
    if (source instanceof Error) {
        const coded = source as Error & { code?: unknown; details?: unknown };
        return { code: text(coded.code), details: isRecord(coded.details) ? coded.details : null, message: text(source.message) };
    }
    return infoFromBody(source);
}

/** The message the server sent, or the given fallback. */
export function projectErrorMessage(e: unknown, fallback: string): string {
    if (e instanceof ApiError) return infoFromBody(e.body).message || fallback;
    return fallback;
}

/** A thrown request error as a ProjectRequestError that keeps the code and details. */
export function toProjectError(e: unknown, fallback: string): ProjectRequestError {
    if (e instanceof ProjectRequestError) return e;
    const info = e instanceof ApiError ? infoFromBody(e.body) : { code: null, details: null, message: null };
    return new ProjectRequestError(info.message || fallback, {
        status: e instanceof ApiError ? e.status ?? null : null,
        code: info.code,
        details: info.details,
        serverMessage: info.message,
    });
}

/** Run a request; a refusal becomes a ProjectRequestError. */
export async function projectRequest<T>(fallback: string, run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (e) {
        throw toProjectError(e, fallback);
    }
}

/** A refused response read with fetch (multipart uploads) as a ProjectRequestError. */
export function projectErrorFromResponse(status: number, body: unknown, fallback: string): ProjectRequestError {
    const info = infoFromBody(body);
    return new ProjectRequestError(info.message || fallback, { status, code: info.code, details: info.details, serverMessage: info.message });
}
