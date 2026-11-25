// What Cowork proposes to change in a cowork's plan (server/usecases/coworkProposals.mts): a repair after the plan
// kept failing, or an offer to make a steady AI step fixed. Nothing is applied until the owner approves it here; an
// approved fixed step can be undone (POST /api/cowork/:id/plan/restore).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanParameter } from './coworkPlan.types';
import { apiJson } from './typedRequest';
import { coworkPlanKey } from './queries/coworkPlan';

type ProposalKind = 'repair' | 'fixed_step';
type ProposalStatus = 'open' | 'approved' | 'dismissed' | 'stale';
type StepKind = 'fixed' | 'ai' | 'ask' | 'deliver';

export interface ProposalChange { id: string; title: string; kind: StepKind; change: 'added' | 'changed' | 'removed' }

export interface ProposalReplay { done: boolean; total: number; same: number; differs: number; partial: number; notReplayable: number }

export interface CoworkProposal {
    id: string;
    kind: ProposalKind;
    reasonCode: string;
    stepId: string | null;
    stepTitle: string | null;
    status: ProposalStatus;
    fingerprint: string;
    createdAt: string | null;
    decidedAt: string | null;
    changes: ProposalChange[];
    widens: string[];
    replay: ProposalReplay | null;
    undoVersion: number | null;
    /** An automatic fix of the wiring that is still the plan: who waits for whom, who reads from whom now (step titles). */
    recipients?: string[];
    parameterChanges?: Array<PlanParameter & { before: string }>;
    wiring?: Array<{ kind: 'waits' | 'reads'; step: string; other: string }>;
}

interface ProposalList { proposals: CoworkProposal[] }

const listOf = (answer: unknown): CoworkProposal[] => {
    const list = answer && typeof answer === 'object' ? (answer as { proposals?: unknown }).proposals : null;
    return Array.isArray(list) ? list as CoworkProposal[] : [];
};

const coworkProposalsKey = (coworkId: string) => ['cowork', 'proposals', coworkId] as const;

/** The item's proposals, newest first. */
export function useCoworkProposals(coworkId: string) {
    return useQuery<CoworkProposal[], Error>({
        queryKey: coworkProposalsKey(coworkId),
        queryFn: async () => listOf(await apiJson<'GET /api/cowork/{id}/proposals', ProposalList>('GET /api/cowork/{id}/proposals', { params: { id: coworkId } })),
        staleTime: 15_000,
        retry: false,
    });
}

/** Approve, put aside, or undo. Each answer is read again where it shows: the plan, the list, Needs you. */
export function useCoworkProposalActions(coworkId: string) {
    const client = useQueryClient();
    const settle = (answer: unknown) => {
        if (answer && typeof answer === 'object' && 'proposals' in answer) client.setQueryData(coworkProposalsKey(coworkId), listOf(answer));
        else void client.invalidateQueries({ queryKey: coworkProposalsKey(coworkId) });
        void client.invalidateQueries({ queryKey: coworkPlanKey(coworkId) });
        void client.invalidateQueries({ queryKey: ['cowork', 'needs-you'] });
    };
    const approve = useMutation<ProposalList, Error, { proposalId: string; fingerprint: string }>({
        mutationFn: ({ proposalId, fingerprint }) => apiJson<'POST /api/cowork/{id}/proposals/{proposalId}/approve', ProposalList>(
            'POST /api/cowork/{id}/proposals/{proposalId}/approve', { params: { id: coworkId, proposalId }, body: { fingerprint } }),
        onSuccess: settle,
    });
    const dismiss = useMutation<ProposalList, Error, string>({
        mutationFn: (proposalId) => apiJson<'POST /api/cowork/{id}/proposals/{proposalId}/dismiss', ProposalList>(
            'POST /api/cowork/{id}/proposals/{proposalId}/dismiss', { params: { id: coworkId, proposalId }, body: {} }),
        onSuccess: settle,
    });
    const restore = useMutation<unknown, Error, number>({
        mutationFn: (version) => apiJson<'POST /api/cowork/{id}/plan/restore'>('POST /api/cowork/{id}/plan/restore', { params: { id: coworkId }, body: { version } }),
        onSuccess: settle,
    });
    const requestChange = useMutation<ProposalList, Error, { instruction: string } | { parameter: PlanParameter & { before: string } }>({
        mutationFn: (body) => apiJson<'POST /api/cowork/{id}/proposals', ProposalList>(
            'POST /api/cowork/{id}/proposals', { params: { id: coworkId }, body }),
        onSuccess: settle,
    });
    return { approve, dismiss, restore, requestChange };
}
