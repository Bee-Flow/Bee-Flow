/**
 * The JSON body of a transcriptions API answer, or a thrown Error that keeps
 * the server's `error` text, its `code`, the HTTP `status` and the parsed body.
 */

export interface TranscriptionsApiError extends Error {
    status?: number;
    code?: string;
    body?: unknown;
}

export async function jsonOrThrow(res: Response) {
    if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        let code: string | null = null;
        // Kept, not discarded. A 409 from the delete guard carries the LIST of
        // what still uses the thing, and `shared/DangerZone.jsx` reads it off
        // `err.body` to re-show that list instead of a bare error. Throwing
        // away the body here is why the meeting delete could not speak to the
        // shared danger zone at all.
        let body: { error?: string; code?: string } | null = null;
        try {
            body = await res.json();
            if (body?.error) msg = body.error;
            if (body?.code) code = body.code;
        } catch (_) { /* no JSON body — a proxy rejection, handled below */ }
        // A 413 is normally refused by the reverse proxy, not by the API, so
        // there is no JSON to read and the user was shown a bare "HTTP 413"
        // with no hint of what went wrong or what to do about it. Only rewrite
        // when the API itself said nothing — a real API 413 (e.g. the 500 MB
        // cap) carries a better message than we could invent here.
        if (res.status === 413 && msg === `HTTP ${res.status}`) {
            msg = 'The audio file is too large for this server\'s upload limit, so it never reached Bee Flow. '
                + 'Record or upload a shorter session, or ask your administrator to raise the upload limit '
                + '(nginx client_max_body_size / ingress proxy-body-size).';
            code = code || 'payload_too_large';
        }
        const err: TranscriptionsApiError = new Error(msg);
        err.status = res.status;
        if (code) err.code = code;
        err.body = body;
        throw err;
    }
    return res.json();
}
