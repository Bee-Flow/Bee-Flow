// Integration status — the ONLY place that knows the /ai/user-settings wire
// contract for availability gating.
//
// It used to live in a `let cache` at the top of hooks/useIntegrationStatus,
// with an in-flight promise beside it to collapse concurrent mounts. React
// Query does both of those for free, and it fixes the thing a module cache
// cannot: logout does not reload the page, so a cache keyed on nothing kept
// answering for the previous account (sessionCaches.ts names what that cost).
// The shared client is cleared on logout, so the answer dies with the session.
//
// The request goes through `authFetch` rather than `apiClient` on purpose: a
// non-ok response here is a STATE the caller renders ("unavailable"), not an
// exception with a parsed error body, and every consuming test mocks
// `authFetch` with a bare `{ ok, status, json }` response.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

/** The raw `GET /ai/user-settings` payload. Consumers read their own keys
 *  (orgEnabledIntegrations, isGoogleUser, hasFirefliesKey, …); `{}` is a
 *  legitimate value and means "nothing is connected". */
export type IntegrationStatus = Record<string, unknown>;

export const integrationStatusKeys = {
    all: ['integration-status'] as const,
};

/**
 * A read that did not answer THROWS instead of resolving to `{}`.
 *
 * `{}` is a legitimate settings payload — it means "nothing is connected" —
 * so returning it for a 500 hands every caller a confident negative. A picker
 * gating on it then drops the apps the org does have and calls it an empty
 * list.
 */
export async function fetchIntegrationStatus(signal?: AbortSignal): Promise<IntegrationStatus> {
    const res = await authFetch(`${API_BASE}/ai/user-settings`, { signal });
    if (!res.ok) throw new Error(`user-settings ${res.status}`);
    return res.json();
}

export function useIntegrationStatusQuery() {
    return useQuery<IntegrationStatus, Error>({
        queryKey: integrationStatusKeys.all,
        queryFn: ({ signal }) => fetchIntegrationStatus(signal),
        // The payload changes rarely within a session and the skill editor
        // mounts this hook on every skill switch; the explicit invalidator is
        // what makes it fresh again, not a clock.
        staleTime: Infinity,
        // A failure is not an answer to remember: without data the query is
        // stale, so the next mount asks again. Retrying first would only
        // delay the "unavailable" the caller has to show anyway.
        retry: false,
    });
}
