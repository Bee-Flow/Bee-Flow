/**
 * The run log's endpoints (server/routes/automation/runs.js, mounted at
 * /api/automation).
 *
 * Two scopes, two pairs of routes — never one route with a scope parameter:
 * /_runs/recent and /_runs/facets are the caller's own runs by contract, and
 * /_runs/org and /_runs/org/facets are the organisation's, behind their own
 * manage_automations check. The org pair answers 403 with a sentence and never
 * narrows to "my runs" instead; the screen shows that sentence.
 */

import { api, type QueryParams } from '@/core/api/client';

import { readFacets, readRunPage } from './readers';
import type { RunFacets, RunPage, RunScope } from '../model/types';

const BASE = '/api/automation/_runs';

export async function listRuns(scope: RunScope, query: QueryParams, signal?: AbortSignal): Promise<RunPage> {
    const path = scope === 'org' ? `${BASE}/org` : `${BASE}/recent`;
    return readRunPage(await api.get<unknown>(path, { query, signal }));
}

/**
 * The chips' counts and the "Now running" rollup over the last `range` hours.
 * The server clamps the window to 1..720.
 */
export async function getRunFacets(
    scope: RunScope,
    query: { range: number; mode?: string; automationId?: string },
    signal?: AbortSignal,
): Promise<RunFacets | null> {
    const path = scope === 'org' ? `${BASE}/org/facets` : `${BASE}/facets`;
    return readFacets(await api.get<unknown>(path, { query, signal }));
}
