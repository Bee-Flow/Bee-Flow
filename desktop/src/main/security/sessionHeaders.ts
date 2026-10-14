/**
 * Announce this client on every request to the configured server.
 *
 * The server reads `X-Beeflow-Client` (server/core/http/requestClient.js) to
 * tell a browser from the Android app from this one — it is a closed enum
 * on a row that already exists, and the only reason it is set here rather
 * than in the SPA is that the SPA is the same bundle in both cases.
 *
 * The header is scoped to the configured server's origin. Sending it to an
 * identity provider during sign-in would tell a third party something about
 * the user's setup for no benefit at all.
 */

import { originOf } from '../server/url.ts';

export const CLIENT_HEADER = 'X-Beeflow-Client';
export const CLIENT_KIND = 'desktop';

export interface ServerOrigins {
    url: string;
    apiOrigin?: string;
}

/** Does a request to this URL carry the client header? */
export function clientHeaderFor(url: string, server: ServerOrigins): boolean {
    const requestOrigin = originOf(url);
    const ours = [originOf(server.url), server.apiOrigin || null].filter(Boolean);
    return Boolean(requestOrigin && ours.includes(requestOrigin));
}

/** The headers to send: the same object when the request is not to the server. */
export function withClientHeader(requestHeaders: Record<string, string>, url: string, server: ServerOrigins): Record<string, string> {
    if (clientHeaderFor(url, server)) return { ...requestHeaders, [CLIENT_HEADER]: CLIENT_KIND };
    return requestHeaders;
}
