/** Deciding an approval, and everything the decision moves. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { automationKeys } from '@/features/automations';
import { notificationKeys } from '@/features/notifications';

import { decideApproval } from '../api/endpoints';
import { approvalKeys } from '../api/keys';
import type { ApprovalDecision } from '../model/types';

export interface Decision {
    decision: ApprovalDecision;
    reason?: string;
}

export function useDecideApproval(
    id: string,
    handlers: { onSuccess?: (vars: Decision) => void; onError?: (error: Error) => void } = {},
) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ decision, reason }: Decision) => decideApproval(id, decision, reason),
        onSuccess: (_data, vars) => {
            handlers.onSuccess?.(vars);
            // The decision changes the run, the recent-runs list, the bell and
            // every approvals list (inbox, drawer badge, Cowork hub), so none
            // of them may keep serving what they had a moment ago — it used to
            // stay under Waiting after "Approved".
            void queryClient.invalidateQueries({ queryKey: approvalKeys.approval(id) });
            void queryClient.invalidateQueries({ queryKey: automationKeys.approvalLists });
            void queryClient.invalidateQueries({ queryKey: automationKeys.recentRuns });
            void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
        },
        onError: handlers.onError,
    });
}
