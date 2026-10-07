/**
 * The hub's shared reads and writes. Each read takes `enabled` so nothing is
 * asked of the server before the gate has opened (the server would 403, and
 * a locked screen must not flash an error first). Every write invalidates the
 * whole `compliance` key space: a closed DSR moves the counts, the deadlines,
 * the attention list and a score at once.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    autoFixCheck,
    getAttention,
    getCheckEvidence,
    getCheckHistory,
    getChecks,
    getCounts,
    getDeadlines,
    getFrameworks,
    hubKeys,
    rerunCheck,
    runAllChecks,
    setFrameworkEnabled,
    setFrameworkRelevance,
} from '../api/hub';

const ALL = ['compliance'] as const;
const POLL_MS = 30_000;

/** A write that refreshes every compliance read once it settles. Every later write uses it. */
export function useComplianceMutation<TArgs, TResult>(fn: (args: TArgs) => Promise<TResult>) {
    const client = useQueryClient();
    return useMutation({
        mutationFn: fn,
        onSettled: () => client.invalidateQueries({ queryKey: ALL }),
    });
}

export const useCounts = (enabled: boolean, opts?: { poll?: boolean }) =>
    useQuery({
        queryKey: hubKeys.counts(),
        queryFn: ({ signal }) => getCounts(signal),
        enabled,
        staleTime: POLL_MS,
        refetchInterval: opts?.poll ? POLL_MS : false,
    });

export const useAttention = (enabled: boolean) =>
    useQuery({ queryKey: hubKeys.attention(), queryFn: ({ signal }) => getAttention(signal), enabled });

export const useDeadlines = (enabled: boolean) =>
    useQuery({ queryKey: hubKeys.deadlines(), queryFn: ({ signal }) => getDeadlines(signal), enabled });

export const useFrameworks = (enabled: boolean) =>
    useQuery({ queryKey: hubKeys.frameworks(), queryFn: ({ signal }) => getFrameworks(signal), enabled });

export const useChecks = (framework: string | null, enabled: boolean) =>
    useQuery({ queryKey: hubKeys.checks(framework), queryFn: ({ signal }) => getChecks(framework, signal), enabled });

export const useCheckHistory = (checkId: string, scopeId: string | null, enabled: boolean) =>
    useQuery({
        queryKey: hubKeys.checkHistory(checkId, scopeId),
        queryFn: ({ signal }) => getCheckHistory(checkId, scopeId, signal),
        enabled,
    });

export const useCheckEvidence = (checkId: string, enabled: boolean) =>
    useQuery({ queryKey: hubKeys.checkEvidence(checkId), queryFn: ({ signal }) => getCheckEvidence(checkId, signal), enabled });

export const useRunAllChecks = () => useComplianceMutation(() => runAllChecks());

export const useRerunCheck = () => useComplianceMutation((checkId: string) => rerunCheck(checkId));

export const useAutoFixCheck = () => useComplianceMutation((checkId: string) => autoFixCheck(checkId));

export const useToggleFramework = () =>
    useComplianceMutation(({ id, enabled }: { id: string; enabled: boolean }) => setFrameworkEnabled(id, enabled));

export const useFrameworkRelevance = () =>
    useComplianceMutation(({ id, relevance, note }: { id: string; relevance: string; note?: string }) =>
        setFrameworkRelevance(id, relevance, note),
    );
