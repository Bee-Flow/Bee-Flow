/**
 * The builder's queries: the overview, one Solution's graph and checks, the
 * Blueprint gallery and history, and a picker's candidates. Screens call
 * these rather than useQuery.
 */

import { useQuery } from '@tanstack/react-query';

import { projectKeys } from '../api/keys';
import { getInstallCounts, listBlueprints, listReleases, planUpgrade } from '../api/packageEndpoints';
import { getCompleteness, getProjectGraph, getSolutionSummary, listCandidates } from '../api/solutionEndpoints';

export function useSolutionSummary() {
    return useQuery({
        queryKey: projectKeys.summary,
        queryFn: ({ signal }) => getSolutionSummary(signal),
    });
}

export function useProjectGraph(id: string, enabled = true) {
    return useQuery({
        queryKey: projectKeys.graph(id),
        queryFn: ({ signal }) => getProjectGraph(id, signal),
        enabled: Boolean(id) && enabled,
    });
}

/**
 * The checks. No stale answer survives a failure — `retry: 1` and the error
 * state are what the screen reads, and a "nothing blocking" from before
 * would leave publishing open while the server can confirm nothing.
 */
export function useCompleteness(id: string) {
    return useQuery({
        queryKey: projectKeys.completeness(id),
        queryFn: ({ signal }) => getCompleteness(id, signal),
        enabled: Boolean(id),
        retry: 1,
    });
}

/** The org-scoped gallery. `enabled` false when the plan has no Blueprint packaging. */
export function useBlueprints(enabled = true) {
    return useQuery({
        queryKey: projectKeys.blueprints,
        queryFn: ({ signal }) => listBlueprints(signal),
        enabled,
        retry: 1,
    });
}

export function useReleases(id: string, enabled: boolean) {
    return useQuery({
        queryKey: projectKeys.releases(id),
        queryFn: ({ signal }) => listReleases(id, signal),
        enabled: Boolean(id) && enabled,
        retry: 1,
    });
}

export function useInstallCounts(id: string, enabled: boolean) {
    return useQuery({
        queryKey: projectKeys.installs(id),
        queryFn: ({ signal }) => getInstallCounts(id, signal),
        enabled: Boolean(id) && enabled,
        retry: 1,
    });
}

/**
 * What an upgrade would change. Asked afresh every time the sheet opens
 * (`gcTime: 0`): an old plan next to a live button is exactly the mistake the
 * plan exists to prevent.
 */
export function useUpgradePlan(id: string, blueprintId: string | null) {
    return useQuery({
        queryKey: projectKeys.upgradePlan(id, blueprintId ?? ''),
        queryFn: () => planUpgrade(id, blueprintId as string),
        enabled: Boolean(id && blueprintId),
        gcTime: 0,
        staleTime: 0,
        retry: false,
    });
}

/** The caller's own things of one kind, for the "Add existing" picker. */
export function useCandidates(kind: string | null) {
    return useQuery({
        queryKey: projectKeys.candidates(kind ?? ''),
        queryFn: ({ signal }) => listCandidates(kind as string, signal),
        enabled: Boolean(kind),
        staleTime: 30_000,
    });
}
