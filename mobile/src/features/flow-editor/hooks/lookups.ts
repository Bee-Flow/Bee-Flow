/**
 * The lists a step editor picks from beyond the catalog: an AI step's
 * knowledge bases, the approver directory, an automation's people and groups,
 * and the HTTP credentials. Each
 * changes rarely and is asked for every time an editor opens, so each is kept
 * for a few minutes; a failed read is the query's error — "could not read the
 * list" — never an empty list.
 */

import { useQuery } from '@tanstack/react-query';

import { getAiStepKnowledgeBases, getApprovalDirectory, getPrincipals, listHttpConnections, lookupKeys } from '../api/lookups';

const STALE_MS = 5 * 60_000;

export function useAiStepKnowledgeBases() {
    return useQuery({ queryKey: lookupKeys.aiStepKnowledgeBases, queryFn: ({ signal }) => getAiStepKnowledgeBases(signal), staleTime: STALE_MS });
}

export function useApprovalDirectory() {
    return useQuery({ queryKey: lookupKeys.approvalDirectory, queryFn: ({ signal }) => getApprovalDirectory(signal), staleTime: STALE_MS });
}

/** The automation's people and groups (the notification recipients' picker); nothing asked before it is saved. */
export function usePrincipals(automationId: string | null | undefined) {
    return useQuery({
        queryKey: lookupKeys.principals(automationId ?? ''),
        queryFn: ({ signal }) => getPrincipals(automationId as string, signal),
        enabled: !!automationId,
        staleTime: STALE_MS,
    });
}

export function useHttpConnections() {
    return useQuery({ queryKey: lookupKeys.httpConnections, queryFn: ({ signal }) => listHttpConnections(signal), staleTime: STALE_MS });
}
