/**
 * Approve and Reject on a run that waits for approval, as every run surface
 * offers them (the run screen, the automation's waiting card):
 *
 *   - an approval whose snapshot asks for answers goes to the approvals
 *     screen with its decide sheet open, which asks for them; posting from
 *     here without them is refused with a 400;
 *   - what came of a decision is said from the server's answer
 *     (model/decisionOutcome.ts): a vote on a panel or a stage chain is a
 *     vote, and the run still waits;
 *   - the legacy first-run confirmation (`awaiting_confirm`) takes its own route.
 *
 * An older server sends no pending approval: Approve then posts as before.
 */

import { useRouter } from 'expo-router';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { runPhase } from '@/shared/runs/runPhase';
import { useToast } from '@/shared/ui';

import { useDecideRunStep } from './mutations';
import { useRunPendingApproval } from './queries';
import { approveRoute, decisionOutcome } from '../model/decisionOutcome';
import type { AutomationRun, RunPendingApproval } from '../model/types';

export interface RunDecision {
    decide: (decision: 'approve' | 'reject') => void;
    pending: boolean;
    /** Still asking whether the approval wants answers: Approve waits, so it never posts without them. */
    checking: boolean;
    /** The approval the run waits on, with its fields; null until known, and from an older server. */
    approval: RunPendingApproval | null;
}

export function useRunDecision(run: AutomationRun | null | undefined, refresh: () => void): RunDecision {
    const router = useRouter();
    const { toast } = useToast();
    const t = useTranslation();
    const runId = run?.id ?? '';
    const firstRun = run?.status === 'awaiting_confirm';
    const waiting = !!runId && !firstRun && runPhase(run).phase === 'paused_approval';
    const approval = useRunPendingApproval(runId, waiting);
    const mutation = useDecideRunStep(runId, refresh, {
        onSuccess: (result) => {
            const outcome = decisionOutcome(result, t);
            toast(outcome.text, outcome.tone);
        },
        onError: (error) => toast(describeError(error).message, 'error'),
    });
    return {
        decide: (decision) => {
            const to = decision === 'approve' ? approveRoute(approval.data) : null;
            if (to) {
                router.push(to);
                return;
            }
            mutation.mutate({ decision, firstRun });
        },
        pending: mutation.isPending,
        checking: waiting && approval.isLoading,
        approval: waiting ? approval.data ?? null : null,
    };
}
