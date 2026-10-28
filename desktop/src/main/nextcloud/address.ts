/**
 * A Nextcloud address typed by a person or taken from a link: one place for
 * the rules, shared by the pairing and the settings schema.
 */

import { hostKind } from '../server/url.ts';

export const INVALID_NEXTCLOUD_ADDRESS = 'That is not a usable Nextcloud address. Use an https:// address (plain http only works for this computer or a private network).';

/**
 * A Nextcloud address from a link, the Bee Flow server or a person: http(s)
 * only, no embedded credentials. Plain http is accepted for this computer and
 * private networks only; a bare host gets https. Returns the origin plus path
 * without a trailing slash, or null.
 */
export function parseNextcloudUrl(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const text = raw.trim();
    if (!text || text.length > 2048) return null;
    let url: URL;
    try {
        url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!url.hostname || url.username || url.password) return null;
    if (url.protocol === 'http:') {
        const kind = hostKind(url.hostname);
        if (kind !== 'loopback' && kind !== 'private') return null;
    }
    return url.origin + url.pathname.replace(/\/+$/, '');
}
