/**
 * fixedEndpointFetch.mts: fetch() for endpoints nobody but the code or the
 * operator chose.
 *
 *   - fixed vendor hosts written in the code (login.microsoftonline.com,
 *     oauth2.googleapis.com, api.github.com, ...), and
 *   - the operator's own sidecars, addressed through an environment variable
 *     (guard-service, classify-service, the search service, a local reranker).
 *
 * No SSRF screen: a sidecar sits on a private network on purpose, which
 * utils/ssrfGuard.safeFetch refuses. A URL that a user, a document, a model or
 * an organisation admin can influence does not belong here: that is safeFetch
 * (user URLs) or configuredEndpointFetch (admin-set endpoints).
 *
 * What it adds to the global fetch is the default time-out of
 * outboundTimeout.mts (OUTBOUND_HTTP_TIMEOUT_MS), with `timeoutMs` and
 * `timeoutPhase` per call.
 */

import { fetchWithTimeout, type OutboundTimeoutOptions } from './outboundTimeout.mts';

// For a call that keeps the plain fetch on purpose and passes this as its signal.
export { defaultTimeoutSignal } from './outboundTimeout.mts';

export type FixedEndpointInit = RequestInit & OutboundTimeoutOptions;

/** Global fetch with the outbound default time-out. */
export function fetchFixedEndpoint(url: string | URL, init: FixedEndpointInit = {}): Promise<Response> {
    return fetchWithTimeout((u: string | URL, i: RequestInit) => globalThis.fetch(u, i), url, init);
}
