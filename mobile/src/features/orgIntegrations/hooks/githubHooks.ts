/** GitHub Sync's reads and writes. Every route needs `manage_agents`; the screen asks only then. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    configureGithubSync,
    disconnectGithubSync,
    getGithubSyncDetails,
    getGithubSyncStatus,
    pushAllToGithub,
    pushPendingToGithub,
} from '../api/github';
import { integrationKeys } from '../api/keys';
import type { GithubSyncForm } from '../model/githubTypes';

const keys = integrationKeys.github;

export function useGithubSyncStatus(enabled: boolean) {
    return useQuery({ queryKey: keys.status, queryFn: ({ signal }) => getGithubSyncStatus(signal), enabled, retry: false });
}

export function useGithubSyncDetails(enabled: boolean) {
    return useQuery({ queryKey: keys.details, queryFn: ({ signal }) => getGithubSyncDetails(signal), enabled, retry: false });
}

/** Any write changes the status (and the per-resource states), so both are re-read. */
function useGithubWrite<V, R>(write: (vars: V) => Promise<R>) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: write,
        onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.all }),
    });
}

export function useConfigureGithubSync() {
    return useGithubWrite((form: GithubSyncForm) => configureGithubSync(form));
}

export function useDisconnectGithubSync() {
    return useGithubWrite((_: void) => disconnectGithubSync());
}

export function usePushAllToGithub() {
    return useGithubWrite((_: void) => pushAllToGithub());
}

export function usePushPendingToGithub() {
    return useGithubWrite((_: void) => pushPendingToGithub());
}
