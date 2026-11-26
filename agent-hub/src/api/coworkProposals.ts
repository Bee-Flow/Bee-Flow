// What Cowork proposes to change in a cowork's plan (server/usecases/coworkProposals.mts): a repair after the plan
// kept failing, or an offer to make a steady AI step fixed. Nothing is applied until the owner approves it here; an
// approved fixed step can be undone (POST /api/cowork/:id/plan/restore).

import { useRef, useState, useEffect } from 'react';
import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlanParameter } from './coworkPlan.types';
import { readCoworkReply } from './readCoworkReply';
import { apiJson, apiRequest } from './typedRequest';
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

const interactionKey = (id: string) => ['cowork', 'task-interaction', id] as const;
export function useTaskInteractionBusy(id: string) {
    return useIsMutating({ mutationKey: interactionKey(id) }) > 0;
}

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
        mutationKey: interactionKey(coworkId),
        mutationFn: ({ proposalId, fingerprint }) => apiJson<'POST /api/cowork/{id}/proposals/{proposalId}/approve', ProposalList>(
            'POST /api/cowork/{id}/proposals/{proposalId}/approve', { params: { id: coworkId, proposalId }, body: { fingerprint } }),
        onSuccess: settle,
    });
    const dismiss = useMutation<ProposalList, Error, string>({
        mutationKey: interactionKey(coworkId),
        mutationFn: (proposalId) => apiJson<'POST /api/cowork/{id}/proposals/{proposalId}/dismiss', ProposalList>(
            'POST /api/cowork/{id}/proposals/{proposalId}/dismiss', { params: { id: coworkId, proposalId }, body: {} }),
        onSuccess: settle,
    });
    const restore = useMutation<unknown, Error, number>({
        mutationFn: (version) => apiJson<'POST /api/cowork/{id}/plan/restore'>('POST /api/cowork/{id}/plan/restore', { params: { id: coworkId }, body: { version } }),
        onSuccess: settle,
    });
    const requestChange = useMutation<ProposalList, Error, { instruction: string; scope?: { fingerprint: string; stepIds: string[] } } | { remove: { fingerprint: string; stepIds: string[] } } | { parameter: PlanParameter & { before: string } }>({
        mutationKey: interactionKey(coworkId),
        mutationFn: (body) => apiJson<'POST /api/cowork/{id}/proposals', ProposalList>(
            'POST /api/cowork/{id}/proposals', { params: { id: coworkId }, body }),
        onSuccess: settle,
    });
    return { approve, dismiss, restore, requestChange };
}

export type CoworkGlobalDestination = 'new_task' | 'attention' | 'shared_tasks' | 'teamwork' | 'preferences' | 'templates' | 'org';
export type CoworkPeopleDestination = 'give' | 'pass' | 'template' | 'share';
type CoworkReplyAction = CoworkGlobalDestination | CoworkPeopleDestination | 'goal' | 'memory' | 'budget' | 'changes' | 'proof' | 'test' | 'compare' | 'run' | 'pause' | 'resume' | 'delete' | 'answer' | 'change' | 'result' | 'history' | 'when' | 'what' | 'uses' | 'sends' | 'actions' | 'steps' | 'people' | 'share' | 'review' | 'overview';
export interface ClockProposal { repeatInterval: 'daily' | 'weekdays' | 'weekly'; daysOfWeek: string[] | null; timeOfDay: string; timezone: string; nextRunAt: string }
export type CoworkSettingChoice = 'what' | 'when' | 'uses' | 'sends';
export interface CoworkReply { section?: string; ownerOnly?: boolean; responses?: string[]; tasks?: {id: string; title: string; detail: string; shared?: boolean}[]; switchTo?: string; choices?: CoworkSettingChoice[]; remove?: {fingerprint: string; stepIds: string[]}; schedule?: ClockProposal; answer: string; action: CoworkReplyAction; instruction: string }
export interface CoworkMessage { role: 'user' | 'assistant'; text: string }

interface ConversationRequest {
    message: string; view: string; history: CoworkMessage[]; scope?: { stepIds: string[]; fingerprint: string };
}

export function useCoworkConversation(id: string) {
    const [partial, setPartial] = useState('');
    const controller = useRef<AbortController | null>(null);
    useEffect(() => () => controller.current?.abort(), [id]);
    const mutation = useMutation({
        mutationKey: interactionKey(id),
        onSettled: () => setPartial(''),
        mutationFn: async (body: ConversationRequest) => {
            controller.current = new AbortController();
            const {signal} = controller.current;
            const response = await apiRequest('POST /api/cowork/{id}/conversation', {
                params: { id }, body, init: { headers: { Accept: 'text/event-stream' }, signal },
            });
            return readCoworkReply<CoworkReply>(response, signal, setPartial);
        },
    });
    return { ...mutation, partial };
}
