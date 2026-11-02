/**
 * The address an iframe block may load: an absolute https URL, nothing else.
 *
 * The frame runs with allow-scripts and allow-same-origin, which is what the
 * usual widgets (booking, maps, chat) need, so the address has to be one
 * that can only come from a web server: no javascript:, data: or blob:
 * forms, and no plain http, which a browser would refuse on an https site
 * anyway. The address itself is chosen by a site editor in the CMS, not by
 * a visitor.
 */
export function safeEmbedSrc(src: unknown): string | null {
    if (typeof src !== 'string') return null;
    const text = src.trim();
    if (!text) return null;
    try {
        return new URL(text).protocol === 'https:' ? text : null;
    } catch {
        return null;
    }
}
