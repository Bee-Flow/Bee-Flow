/** The approvals queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { getApproval, listApprovals } from '../api/endpoints';
import { approvalKeys } from '../api/keys';
import type { ApprovalScope } from '../model/types';

/**
 * How often an open inbox and the drawer's badge re-read the list: the web's
 * interval (agent-hub useApprovalsNav), so an approval that arrives while the
 * screen is open shows up without a pull. React Query pauses it while the app
 * is in the background (core/providers/platformBridges' focusManager).
 */
const APPROVALS_POLL_MS = 30_000;

/**
 * The inbox. The tab hub reads the pending list too, as a pointer to this
 * screen, with its own freshness and a single retry (a licence can withhold
 * the list, and the rest of the hub must not wait on it). `poll` is for what
 * someone watches for new arrivals: the inbox itself and the drawer's badge.
 */
export function useApprovals(
    scope: ApprovalScope,
    options: { staleTime: number; retry?: number | boolean; enabled?: boolean; poll?: boolean },
) {
    return useQuery({
        queryKey: approvalKeys.approvals(scope),
        queryFn: ({ signal }) => listApprovals(scope, signal),
        staleTime: options.staleTime,
        enabled: options.enabled ?? true,
        refetchInterval: options.poll ? APPROVALS_POLL_MS : false,
        ...(options.retry === undefined ? {} : { retry: options.retry }),
    });
}

export function useApproval(id: string) {
    return useQuery({
        queryKey: approvalKeys.approval(id),
        queryFn: ({ signal }) => getApproval(id, signal),
    });
}
