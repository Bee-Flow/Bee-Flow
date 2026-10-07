/**
 * The trigger's health check (the web header's Diagnose). The AI Act
 * declaration lives in features/ai-act.
 */

import { useMutation } from '@tanstack/react-query';

import type { MutationHandlers } from '@/features/automations';

import { diagnoseTrigger, type TriggerDiagnosis } from '../api/checks';
import { ensureDraftSaved } from '../state/ensureSaved';

/** Probe the trigger pipeline. The server reads the STORED trigger, so the draft is saved first. */
export function useDiagnoseTrigger(flowKey: string, handlers: MutationHandlers<TriggerDiagnosis> = {}) {
    return useMutation({
        mutationFn: async () => diagnoseTrigger(await ensureDraftSaved(flowKey)),
        onSuccess: (result) => handlers.onSuccess?.(result, undefined),
        onError: handlers.onError,
    });
}
