// The server's reading of the code on screen: parameters, findings,
// capabilities and approvals. Debounced by 400 ms, so typing sends one
// request per pause, not one per key.
import { useMemo } from 'react';
import { useCodeAnalysis, type CodeAnalysis } from '../../../../../../api/queries/automation/codeStep';
import useDebouncedValue from '../../../../../../hooks/useDebouncedValue';

export const ANALYZE_DEBOUNCE_MS = 400;

export interface StepCodeAnalysis {
    analysis: CodeAnalysis | null;
    /** No answer yet, and one is on its way. */
    reading: boolean;
    /** The checks could not run (server refused, offline, older server). */
    failed: boolean;
}

export function useStepCodeAnalysis({ code, allowedHosts, allowedTools, automationId, stepId }: {
    code: string; allowedHosts: string[]; allowedTools: string[]; automationId: string | null; stepId: string | null;
}): StepCodeAnalysis {
    const debounced = useDebouncedValue(code, ANALYZE_DEBOUNCE_MS);
    const hostsKey = allowedHosts.join('\n');
    const toolsKey = allowedTools.join('\n');
    const req = useMemo(() => ({
        code: debounced,
        allowedHosts: hostsKey ? hostsKey.split('\n') : [],
        allowedTools: toolsKey ? toolsKey.split('\n') : [],
        automationId,
        stepId,
    }), [debounced, hostsKey, toolsKey, automationId, stepId]);
    const q = useCodeAnalysis(req);
    const hasCode = code.trim().length > 0;
    return {
        analysis: hasCode ? q.data ?? null : null,
        reading: hasCode && !q.data && !q.isError,
        failed: hasCode && q.isError && !q.data,
    };
}
