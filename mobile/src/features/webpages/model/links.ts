/**
 * Make a server-relative public path absolute against the configured server.
 *
 * The form list hands back `/f/<token>` with no origin, and the MCP token
 * endpoint degrades to a bare `/mcp` when PUBLIC_BASE_URL is unset. Both are
 * only useful to a person if they can paste them somewhere, and the origin
 * this device reaches the server on is the one origin we know actually works.
 * Forms and MCP import it from '@/features/webpages', next to LinkActions.
 */

import { apiUrl } from '@/core/api/server';

export function absoluteUrl(pathOrUrl: string): string {
    if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
    return apiUrl(pathOrUrl);
}
