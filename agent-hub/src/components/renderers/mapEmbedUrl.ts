/**
 * Which map URLs a chat message may load in an iframe. The embed URL comes
 * from model or tool output, so only the Google Maps Embed API is framed;
 * anything else is shown as a plain link the reader can choose to open.
 */
const EMBED_ORIGIN = 'https://www.google.com';
const EMBED_PATH = '/maps/embed';

/** The URL when it is a Google Maps embed, otherwise null. */
export function trustedMapEmbedUrl(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') return null;
    try {
        const u = new URL(url.trim());
        if (u.origin !== EMBED_ORIGIN) return null;
        if (u.pathname !== EMBED_PATH && !u.pathname.startsWith(`${EMBED_PATH}/`)) return null;
        return u.href;
    } catch {
        return null;
    }
}

/** An absolute http(s) URL for a link that opens in a new tab, otherwise null. */
export function externalLinkUrl(url: unknown): string | null {
    if (typeof url !== 'string' || url.trim() === '') return null;
    try {
        const u = new URL(url.trim());
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch {
        return null;
    }
}
