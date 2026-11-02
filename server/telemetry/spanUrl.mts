/**
 * spanUrl.mts: URLs as trace spans may carry them.
 *
 * Span attributes leave the server for the OTLP collector. A query string
 * can hold a token or personal data, and a path segment can be a share or
 * webhook token (/s/<token>), so the http and undici instrumentations rewrite
 * their URL attributes through here: no query string, no credentials, and a
 * token-like path segment replaced by `:token`. UUIDs stay: they are ids.
 */

// 24+ url-safe characters with at least one digit: random tokens, not route words.
const TOKEN_SEGMENT = /^(?=.*\d)(?:[a-z]{2,8}_)?[A-Za-z0-9_\-]{24,}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path with token-like segments masked and the query string dropped. */
export function scrubPath(path: string): string {
    const bare = String(path ?? '').split(/[?#]/, 1)[0];
    return bare.split('/').map((seg) => {
        let decoded = seg;
        try { decoded = decodeURIComponent(seg); } catch { /* keep the raw segment */ }
        return !UUID.test(decoded) && TOKEN_SEGMENT.test(decoded) ? ':token' : seg;
    }).join('/');
}

/** A full URL with its path scrubbed, and no query string, fragment or credentials. */
export function scrubUrl(url: string): string {
    try {
        const u = new URL(url);
        return `${u.protocol}//${u.host}${scrubPath(u.pathname)}`;
    } catch {
        return scrubPath(url);
    }
}

/** The span attributes that carry a URL or a path, and how each is rewritten. */
const URL_ATTRIBUTES: Record<string, (v: string) => string> = {
    'http.url': scrubUrl,
    'url.full': scrubUrl,
    'http.target': scrubPath,
    'url.path': scrubPath,
};
const DROPPED_ATTRIBUTES = ['url.query'];

interface WritableSpan {
    attributes?: Record<string, unknown>;
    setAttribute: (key: string, value: string) => unknown;
}

/** Rewrite a started span's URL attributes in place (the SDK span keeps them on `attributes`). */
export function scrubSpanUrls(span: WritableSpan | null | undefined): void {
    if (!span || typeof span.setAttribute !== 'function') return;
    const attrs = span.attributes || {};
    for (const [key, scrub] of Object.entries(URL_ATTRIBUTES)) {
        const value = attrs[key];
        if (typeof value === 'string') span.setAttribute(key, scrub(value));
    }
    for (const key of DROPPED_ATTRIBUTES) {
        if (key in attrs) {
            if (span.attributes) delete span.attributes[key];
        }
    }
}
