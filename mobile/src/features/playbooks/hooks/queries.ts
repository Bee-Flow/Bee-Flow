/** Playbook queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { getAppAccess, getPlaybook, listPlaybooks, listTables, listTierModels } from '../api/endpoints';
import { playbookKeys } from '../api/keys';
import { depthTiers } from '../model/newPlaybook';
import { isPolling } from '../model/phaseMachine';

export function usePlaybooks() {
    return useQuery({
        queryKey: playbookKeys.list,
        queryFn: ({ signal }) => listPlaybooks(signal),
    });
}

const POLL_MS = 2000;
const POLL_MAX_MS = 16_000;

/**
 * One playbook. While a server-run phase is running on an ACTIVE playbook
 * (a stopped one leaves its phases `running`, and must not poll for ever) it
 * is read again every two seconds — the server heals a finished fill and a
 * dead run on that GET — backing off to sixteen after failed reads.
 */
export function usePlaybook(id: string) {
    return useQuery({
        queryKey: playbookKeys.detail(id),
        queryFn: ({ signal }) => getPlaybook(id, signal),
        enabled: Boolean(id),
        refetchInterval: (query) => {
            if (!isPolling(query.state.data)) return false;
            return Math.min(POLL_MAX_MS, POLL_MS * 2 ** query.state.fetchFailureCount);
        },
    });
}

/** Where the governed app stands (published, to whom, how many named people). */
export function useAppAccess(appId: string | null) {
    return useQuery({
        queryKey: playbookKeys.app(appId ?? ''),
        queryFn: ({ signal }) => getAppAccess(appId as string, signal),
        enabled: Boolean(appId),
    });
}

/** The tables to pick from, read only once the person chooses "an existing table". */
export function useTableChoices(enabled: boolean) {
    return useQuery({
        queryKey: playbookKeys.tables,
        queryFn: ({ signal }) => listTables(signal),
        enabled,
    });
}

/** The depth tiers the New form offers; the web's two while the answer is out. */
export function usePlaybookTiers(): readonly string[] {
    const query = useQuery({
        queryKey: playbookKeys.tiers,
        queryFn: ({ signal }) => listTierModels(signal),
        staleTime: 10 * 60_000,
    });
    return depthTiers(query.data);
}
