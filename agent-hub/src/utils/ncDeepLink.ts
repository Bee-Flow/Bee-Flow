/**
 * Deep link into the Nextcloud embed.
 *
 * Inside Nextcloud the SPA is framed at the AppAPI proxy path, so its own
 * pathname never says which screen to open. The connector's embed script
 * (nextcloud-connector/src/server.js) copies a validated `?path=` of the
 * Nextcloud page into the frame URL as `?ncPath=`; this reads it ONCE on boot
 * and swaps the URL for that in-app path, before any state initialiser parses
 * `window.location.pathname`. The same shape of path is what the SPA's own
 * pushState navigation already puts in the address bar inside the embed.
 */

// Relative in-app path only: no scheme, no `//`, no `..`.
const SAFE_PATH = /^\/app\/[A-Za-z0-9/_\-?=&.%]*$/;

export function parseNcPath(search: string): string | null {
    try {
        const value = new URLSearchParams(search).get('ncPath');
        if (!value || value.includes('//') || value.includes('..')) return null;
        return SAFE_PATH.test(value) ? value : null;
    } catch {
        return null;
    }
}

export function applyNcDeepLink(win: Pick<Window, 'location' | 'history'> = window): string | null {
    const path = parseNcPath(win.location.search);
    if (!path) return null;
    try {
        win.history.replaceState({}, '', path);
        return path;
    } catch {
        return null;
    }
}
