/**
 * What a page in the workspace window is, measured against the configured
 * server: the server itself, the server over plain http from another
 * machine, or somewhere else entirely.
 */

import { hostKind, originOf } from './url.ts';

/** Is this URL on the configured server's origin? */
export function isServerNavigation(url: string, serverUrl: string): boolean {
    const server = originOf(serverUrl);
    return Boolean(server && originOf(url) === server);
}

/** Is this page the configured server, reached over plain http from another machine? */
export function isUnencrypted(url: string, serverUrl: string): boolean {
    if (!serverUrl || originOf(url) !== originOf(serverUrl)) return false;
    const parsed = new URL(serverUrl);
    return parsed.protocol === 'http:' && hostKind(parsed.hostname) !== 'loopback';
}

/**
 * What the window title adds to the page's own title.
 *
 * Plain http to another machine, and any page that is not the workspace (a
 * sign-in provider, mid-sign-in) by its host — the window has no address
 * bar, and a page borrowing the workspace's frame should not be mistaken
 * for it.
 */
export function titleSuffix(url: string, serverUrl: string): string {
    if (!url || url.startsWith('file:')) return '';
    if (isServerNavigation(url, serverUrl)) return isUnencrypted(url, serverUrl) ? 'not encrypted' : '';
    try {
        return new URL(url).host;
    } catch {
        return '';
    }
}
