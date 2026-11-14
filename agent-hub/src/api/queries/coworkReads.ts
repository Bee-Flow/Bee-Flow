// Cowork reads: the run history of one assigned task, and the mail apps a mail trigger can watch.

import { useQuery } from '@tanstack/react-query';
import { listCoworkAgents, listCoworkMailProviders, listCoworkRuns } from '../coworkApi';
import type { CoworkAgent, CoworkRun } from '../cowork.types';

/**
 * The most recent runs of one item. `reloadKey` is part of the key, so the page
 * bumping it (a run just finished) reads again where the effect used to re-run.
 */
export function useCoworkRunsQuery(coworkId: string | null | undefined, reloadKey: number | undefined) {
    return useQuery<{ runs: CoworkRun[]; total: number }, Error>({
        queryKey: ['cowork', 'runs', coworkId ?? '', reloadKey ?? 0],
        enabled: !!coworkId,
        queryFn: () => listCoworkRuns(coworkId as string),
        staleTime: 0,
        retry: false,
    });
}

/**
 * The mail apps the user has connected, from Cowork's own route: the server
 * answers with the check a save runs, so the settings offer what a save accepts.
 */
export function useCoworkMailProvidersQuery() {
    return useQuery<string[], Error>({
        queryKey: ['cowork', 'mail-providers'],
        queryFn: listCoworkMailProviders,
        staleTime: 60_000,
        retry: false,
    });
}

const NO_AGENTS: CoworkAgent[] = [];

/** The agents a cowork item may run as; a refusal or a failure is none (the picker then hides). */
export function useCoworkAgents(enabled = true): CoworkAgent[] {
    const query = useQuery<CoworkAgent[]>({
        queryKey: ['cowork', 'agents'],
        enabled,
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                return await listCoworkAgents();
            } catch {
                return NO_AGENTS;
            }
        },
    });
    return enabled ? query.data ?? NO_AGENTS : NO_AGENTS;
}
