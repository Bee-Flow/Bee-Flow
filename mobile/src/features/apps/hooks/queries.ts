/** The Studio app queries. Screens and the runner call these, not useQuery. */

import { useQuery } from '@tanstack/react-query';

import { getAppActionRun, getAppRuntime, listStudioApps } from '../api/endpoints';
import { appKeys } from '../api/keys';
import { keepPolling } from '../model/actionRun';

/** `enabled: false` for someone the app_studio capability would refuse (the list route 403s). */
export function useStudioApps({ enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: appKeys.apps,
        queryFn: ({ signal }) => listStudioApps(signal),
        enabled,
    });
}

export function useAppRuntime(id: string, draft = false) {
    return useQuery({
        queryKey: appKeys.appRuntime(id, draft),
        queryFn: ({ signal }) => getAppRuntime(id, signal, draft),
        enabled: Boolean(id),
        // An app's definition only changes when its owner republishes, and a
        // refetch mid-form would reset half-typed answers.
        staleTime: 5 * 60_000,
    });
}

/** How often a 202'd run is asked about (the web's runner asks every 2 s). */
const RUN_POLL_MS = 3000;

/**
 * The poll of a 202'd action run. It stops the moment an answer says the run
 * has stopped, or the poll fails (retrying is the runner's button) — a
 * forgotten interval on a phone is a battery complaint.
 */
export function useAppActionRun(appId: string, runId: string | null) {
    return useQuery({
        queryKey: appKeys.actionRun(appId, runId),
        queryFn: ({ signal }) => getAppActionRun(appId, runId as string, signal),
        enabled: Boolean(runId),
        refetchInterval: (query) => (keepPolling(query.state.data, query.state.status === 'error') ? RUN_POLL_MS : false),
        retry: false,
        // The poll is the live answer; a cached one would freeze the spinner.
        staleTime: 0,
    });
}
