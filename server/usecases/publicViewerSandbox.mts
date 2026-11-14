/**
 * Response policy of the public viewer's content document and extras
 * (routes/publicViewer.js). Both are served at an opaque origin even when
 * opened as a top-level page: the CSP sandbox matches the viewer iframe's
 * `sandbox` attribute and never grants allow-same-origin.
 */
export const CONTENT_SANDBOX = 'sandbox allow-scripts allow-forms';
const EXTRAS_CSP = "sandbox allow-forms; script-src 'none'; object-src 'none'; frame-ancestors 'self'";

// Extras rendered inline: stylesheets, scripts, fonts, raster images, media,
// PDF, and the html/svg files the snapshot sanitises. Anything else (xml,
// json, source files, unknown) is a download.
const INLINE_EXTRA_TYPES = [
    'text/css', 'application/javascript', 'text/javascript', 'text/html', 'image/svg+xml',
    'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/x-icon',
    'font/', 'audio/', 'video/', 'application/pdf',
];

function isInlineExtraType(contentType: string): boolean {
    const ct = String(contentType || '').toLowerCase().split(';')[0].trim();
    return INLINE_EXTRA_TYPES.some(t => (t.endsWith('/') ? ct.startsWith(t) : ct === t));
}

/** The headers of an extra file's response, before its caching headers. */
export function extraResponseHeaders(contentType: string | null | undefined): Record<string, string> {
    const type = contentType || 'application/octet-stream';
    const headers: Record<string, string> = {
        'Content-Type': type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': EXTRAS_CSP,
    };
    if (!isInlineExtraType(type)) headers['Content-Disposition'] = 'attachment';
    return headers;
}
