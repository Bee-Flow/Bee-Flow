// The default transport of useUsage: GET the "who uses this" endpoint of a
// kind through authFetch. Lives here so the hook itself holds no fetch.

import { API_BASE, authFetch } from '../../utils/helpers';
import { logger } from '../../utils/logger';

/**
 * The API path segment per kind. Only kinds with a usage endpoint appear
 * here; anything else needs an explicit `fetcher`, and the default fetcher
 * refuses rather than guessing a URL that would 404 into a silent [].
 *
 * Which of these the server ANSWERS today: only `datatables` (GET
 * /api/datatables/:id/usage). The other endpoints land with their tracks —
 * kb → K5, agents → A1, skills → S1, webpages → W5, transcriptions → M2 —
 * and until each one does, the hook resolves to the "could not load who
 * uses this" state for that kind (a 404 is an error, so `usage` becomes []
 * with `error` set, never a silent "nothing depends on it"). The map is
 * deliberately not shrunk to the one live kind: it is the contract the
 * tracks build against, and a consumer wired up now needs no client change
 * when its endpoint arrives.
 */
export const USAGE_KIND_PATH: Readonly<Record<string, string>> = Object.freeze({
    kb: 'kb',
    agent: 'agents',
    skill: 'skills',
    datatable: 'datatables',
    webpage: 'webpages',
    meeting: 'transcriptions',
});

/** `${API_BASE}/api/<kindPath>/<id>/usage`, or null for a kind without one. */
export function usageUrl(kind: string, id: string | number | null | undefined): string | null {
    const segment = USAGE_KIND_PATH[kind];
    if (!segment || id == null || id === '') return null;
    return `${API_BASE}/api/${segment}/${encodeURIComponent(String(id))}/usage`;
}

/** A failed read, carrying datatablesApi's fields so a caller can tell a 403
 *  from a 404 if it wants to. */
interface UsageError extends Error {
    status?: number;
    code?: string | null;
    body?: unknown;
}

/** Default transport: GET the usage endpoint through the app's authFetch. */
export async function defaultUsageFetcher(kind: string, id: string | number | null | undefined): Promise<unknown> {
    const url = usageUrl(kind, id);
    if (!url) throw new Error(`No usage endpoint for kind "${kind}"`);
    const res = await authFetch(url);
    let body = null;
    try { body = await res.json(); } catch (err) { logger.debug('empty or non-JSON body', err); }
    if (!res.ok) {
        const err: UsageError = new Error(body?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.code = body?.code || null;
        err.body = body;
        throw err;
    }
    return body;
}
