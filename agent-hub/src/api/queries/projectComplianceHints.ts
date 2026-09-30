// The project compliance hint: the ONLY place that knows the
// /api/projects/:id/compliance-hints wire contract.
//
// At most one gentle hint per project, for an owner or editor who can act on
// it. Deliberately quiet: its own cache root (so the project's live feed,
// which invalidates everything under `projects/<id>`, never refetches it on a
// chat message), five minutes stale, no polling, no refetch on focus, no
// retries. A failed read is simply "no hint" — the component renders nothing.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';

export type ProjectComplianceHintKey =
    | 'project_foreign_members'
    | 'project_dangling_members'
    | 'project_orphaned_content'
    | 'project_files_unscanned';

export interface ProjectComplianceHint {
    key: ProjectComplianceHintKey;
    severity: 'low' | 'medium' | 'high';
    titleKey: string;
    params: { count: number };
    action: { kind: 'navigate'; target: string };
}

export interface ProjectComplianceHintResponse { hint: ProjectComplianceHint | null }

export const projectComplianceHintKeys = {
    all: ['project-compliance-hint'] as const,
    hint: (projectId: string) => ['project-compliance-hint', projectId] as const,
};

const STALE_MS = 5 * 60 * 1000;

const base = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/compliance-hints`;

export function useProjectComplianceHint(projectId: string | null | undefined, { enabled = true }: { enabled?: boolean } = {}) {
    return useQuery({
        queryKey: projectComplianceHintKeys.hint(projectId || ''),
        queryFn: async ({ signal }) => {
            const res = await apiClient.get<ProjectComplianceHintResponse>(base(projectId as string), { signal, retry: false });
            return res && typeof res === 'object' && 'hint' in res ? res : { hint: null };
        },
        enabled: enabled && !!projectId,
        staleTime: STALE_MS,
        refetchOnWindowFocus: false,
        retry: false,
    });
}

export type HintDecision = { kind: 'dismiss' } | { kind: 'snooze'; days: 7 | 30 };

/**
 * Put the current hint away (dismiss, or snooze for 7 or 30 days). The hint
 * disappears at once; when the server refuses, it comes back and the caller
 * gets the error to say so quietly next to it.
 */
export function useDecideProjectComplianceHint(projectId: string) {
    const client = useQueryClient();
    const key = projectComplianceHintKeys.hint(projectId);
    return useMutation({
        mutationFn: async ({ hintKey, decision }: { hintKey: ProjectComplianceHintKey; decision: HintDecision }) => {
            const url = `${base(projectId)}/${encodeURIComponent(hintKey)}/${decision.kind}`;
            return apiClient.post(url, decision.kind === 'snooze' ? { days: decision.days } : {}, { retry: false });
        },
        onMutate: async () => {
            await client.cancelQueries({ queryKey: key });
            const previous = client.getQueryData<ProjectComplianceHintResponse>(key);
            client.setQueryData<ProjectComplianceHintResponse>(key, { hint: null });
            return { previous };
        },
        onError: (_err, _vars, ctx) => {
            if (ctx?.previous) client.setQueryData(key, ctx.previous);
        },
        // The next hint in line (if any) shows after the next quiet read, not
        // in the same breath as the one just put away.
        onSettled: () => { void client.invalidateQueries({ queryKey: key, refetchType: 'none' }); },
    });
}
