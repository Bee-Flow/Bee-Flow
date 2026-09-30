/**
 * The trigger's health check (the web header's Diagnose) and the routine's
 * AI Act declaration (the web Settings tab's Compliance block): its read and
 * the ladder's write.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { MutationHandlers } from '@/features/automations';

import {
    diagnoseTrigger,
    getAiActAssessment,
    saveAiActAssessment,
    type AiActAnswersBody,
    type AiActAssessment,
    type TriggerDiagnosis,
} from '../api/checks';
import { flowKeys } from '../api/keys';
import { ensureDraftSaved } from '../state/ensureSaved';

/** Probe the trigger pipeline. The server reads the STORED trigger, so the draft is saved first. */
export function useDiagnoseTrigger(flowKey: string, handlers: MutationHandlers<TriggerDiagnosis> = {}) {
    return useMutation({
        mutationFn: async () => diagnoseTrigger(await ensureDraftSaved(flowKey)),
        onSuccess: (result) => handlers.onSuccess?.(result, undefined),
        onError: handlers.onError,
    });
}

/** The saved AI Act assessment; `enabled` false skips the read (no permission to see it). */
export function useAiActAssessment(automationId: string | null, enabled = true) {
    return useQuery({
        queryKey: flowKeys.aiAct(automationId ?? ''),
        queryFn: () => getAiActAssessment(automationId as string),
        enabled: enabled && Boolean(automationId),
    });
}

/**
 * Record the ladder's answers as a self-declaration. The stored row the server
 * answers becomes the cached assessment at once (the chip turns), and the
 * read is invalidated so the next look comes from the server.
 */
export function useSaveAiActAssessment(automationId: string, handlers: MutationHandlers<AiActAssessment, AiActAnswersBody> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (answers: AiActAnswersBody) => saveAiActAssessment(automationId, answers),
        onSuccess: (row, answers) => {
            queryClient.setQueryData(flowKeys.aiAct(automationId), row);
            void queryClient.invalidateQueries({ queryKey: flowKeys.aiAct(automationId) });
            handlers.onSuccess?.(row, answers);
        },
        onError: handlers.onError,
    });
}
