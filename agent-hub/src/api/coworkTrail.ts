// The trail of a Cowork item over GET /api/cowork/:id/audit (server/usecases/coworkAudit.mts): who changed what, when.
// Field names only, and the values of the schedule and the plan; never the text of the work.

import { useQuery } from '@tanstack/react-query';
import { apiJson } from './typedRequest';

export interface TrailEntry {
    action: string;
    at: string | null;
    /** The viewer made this change; an entry by someone else (an administrator) is not named. */
    byYou: boolean;
    /** Cowork made this change by itself (an automatic fix). Absent from older servers. */
    byCowork?: boolean;
    changed: string[];
    values: Record<string, unknown>;
}

async function getCoworkTrail(id: string): Promise<TrailEntry[]> {
    const body = await apiJson<'GET /api/cowork/{id}/audit', { entries?: TrailEntry[] }>('GET /api/cowork/{id}/audit', { params: { id } });
    return Array.isArray(body.entries) ? body.entries : [];
}

/** The trail, read only when asked for (the section is folded until opened). */
export function useCoworkTrail(coworkId: string, enabled: boolean) {
    return useQuery<TrailEntry[], Error>({
        queryKey: ['cowork', 'trail', coworkId],
        enabled,
        queryFn: () => getCoworkTrail(coworkId),
        staleTime: 0,
        retry: false,
    });
}
