/**
 * The AI Act declaration's reads and writes. Keys sit under ['compliance'],
 * so a Compliance Center write refreshes them too.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    enableMarking,
    getAiActAssessment,
    getAiActSignals,
    listAiActAssessments,
    saveAiActAssessment,
    type AiActAnswersBody,
    type AiActAssessment,
    type AiActKind,
    type AiActSignals,
} from './api';
import { aiActKeys } from './keys';

/** The saved AI Act assessment; `enabled` false skips the read (no permission to see it). */
export function useAiActAssessment(kind: AiActKind, id: string | null, enabled = true) {
    return useQuery({
        queryKey: aiActKeys.one(kind, id ?? ''),
        queryFn: () => getAiActAssessment(kind, id as string),
        enabled: enabled && Boolean(id),
    });
}

/** Every saved declaration in the org (the AI Act › Systems list). */
export function useAiActAssessments(enabled = true) {
    return useQuery({ queryKey: aiActKeys.list, queryFn: listAiActAssessments, enabled });
}

/**
 * Record the ladder's answers as a self-declaration. The stored row the server
 * answers becomes the cached assessment at once (the chip turns), and the
 * reads are invalidated so the next look comes from the server.
 */
export function useSaveAiActAssessment(kind: AiActKind, id: string, onSuccess?: (row: AiActAssessment) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (answers: AiActAnswersBody) => saveAiActAssessment(kind, id, answers),
        onSuccess: (row) => {
            queryClient.setQueryData(aiActKeys.one(kind, id), row);
            void queryClient.invalidateQueries({ queryKey: aiActKeys.all });
            onSuccess?.(row);
        },
    });
}

/**
 * The ladder's "Enable marking" (the web's enableMarking): switch the org's
 * Art. 50(2) marking on, then read the live signals so the card turns green.
 * Where the signals route is absent, the flip is reflected locally.
 */
export function useEnableMarking(kind: AiActKind, id: string, onSuccess?: (signals: AiActSignals | null) => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async () => {
            await enableMarking();
            return getAiActSignals(kind, id);
        },
        onSuccess: (signals) => {
            void queryClient.invalidateQueries({ queryKey: ['compliance'] });
            onSuccess?.(signals);
        },
    });
}
