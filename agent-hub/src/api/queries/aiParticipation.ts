// Settings for the AI that decides by itself when to take part in team chats
// and comment threads: the organisation's policy (admins) and each person's
// own opt-out. The server side is routes/aiParticipation.js; the rules those
// settings feed live in server/projects/participation/.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export type AiSensitivity = 'conservative' | 'balanced' | 'eager';

export interface OrgAiParticipationSettings {
    /** The AI may join conversations by itself (a chat must still choose Auto). */
    autoAllowed: boolean;
    /** A chat may let the AI answer every message. */
    alwaysAllowed: boolean;
    /** The AI may join comment threads by itself too. */
    commentsAutoAllowed: boolean;
    sensitivity: AiSensitivity;
    cooldownMinutes: number;
    maxAutoPerChatHour: number;
    maxAutoPerProjectDay: number;
    maxGatesPerChatHour: number;
    maxGatesPerOrgDay: number;
    quietSeconds: number;
    maxDebounceSeconds: number;
    unansweredMinutes: number;
    commentUnansweredMinutes: number;
}

export interface OrgAiParticipationPolicy extends OrgAiParticipationSettings {
    /** Saved at least once, rather than the product default. */
    configured: boolean;
    ranges: Partial<Record<keyof OrgAiParticipationSettings, [number, number]>>;
}

export interface MyAiParticipation { autoJoinOnMyMessages: boolean }

const BASE = '/api/ai-participation';

export const aiParticipationKeys = {
    all: ['aiParticipation'] as const,
    org: (orgId: string) => ['aiParticipation', 'org', orgId] as const,
    me: ['aiParticipation', 'me'] as const,
};

export function useOrgAiParticipation(orgId: string | null | undefined) {
    return useQuery<OrgAiParticipationPolicy, Error>({
        queryKey: aiParticipationKeys.org(orgId || ''),
        enabled: !!orgId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<OrgAiParticipationPolicy>(`${BASE}/org/${encodeURIComponent(orgId!)}`, { signal, retry: false });
            if (!body) throw new Error('Could not load the AI participation settings');
            return body;
        },
    });
}

export function useSaveOrgAiParticipation(orgId: string) {
    const qc = useQueryClient();
    return useMutation<OrgAiParticipationPolicy, Error, OrgAiParticipationSettings>({
        mutationFn: async (settings) => {
            const body = await apiClient.put<OrgAiParticipationPolicy>(`${BASE}/org/${encodeURIComponent(orgId)}`, settings, { retry: false });
            if (!body) throw new Error('Could not save the AI participation settings');
            return body;
        },
        onSuccess: (saved) => { qc.setQueryData(aiParticipationKeys.org(orgId), saved); },
    });
}

export function useMyAiParticipation(enabled = true) {
    return useQuery<MyAiParticipation, Error>({
        queryKey: aiParticipationKeys.me,
        enabled,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<MyAiParticipation>(`${BASE}/me`, { signal, retry: false });
            return { autoJoinOnMyMessages: body?.autoJoinOnMyMessages !== false };
        },
    });
}

/** Change one's own opt-out. The switch moves at once and moves back if the server refuses. */
export function useSaveMyAiParticipation() {
    const qc = useQueryClient();
    return useMutation<MyAiParticipation, Error, MyAiParticipation, { previous?: MyAiParticipation }>({
        mutationFn: async (pref) => {
            const body = await apiClient.put<MyAiParticipation>(`${BASE}/me`, pref, { retry: false });
            return { autoJoinOnMyMessages: body?.autoJoinOnMyMessages !== false };
        },
        onMutate: async (pref) => {
            await qc.cancelQueries({ queryKey: aiParticipationKeys.me });
            const previous = qc.getQueryData<MyAiParticipation>(aiParticipationKeys.me);
            qc.setQueryData(aiParticipationKeys.me, pref);
            return { previous };
        },
        onError: (_e, _pref, ctx) => { if (ctx?.previous) qc.setQueryData(aiParticipationKeys.me, ctx.previous); },
        onSuccess: (saved) => { qc.setQueryData(aiParticipationKeys.me, saved); },
    });
}
