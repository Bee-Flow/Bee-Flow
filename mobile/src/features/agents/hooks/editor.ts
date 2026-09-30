/**
 * The editor's reads and writes. Each write owns its invalidation: after a
 * save the profile, the list and the chat header must show the new name at
 * once, and the concept the editor reads is replaced by the server's echo.
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { DetailQuery } from '@/shared/patterns';

import {
    createAgent,
    getAgentDraft,
    publishAgentVersion,
    restoreAgentVersion,
    setAgentAudience,
    updateAgent,
} from '../api/editorEndpoints';
import { agentKeys } from '../api/keys';
import { createPayload, savePayload, type AgentDetail, type AgentDraft } from '../model/draft';
import type { Persona } from '../model/refineMerge';

export function useAgentDraft(id: string) {
    return useQuery({
        queryKey: agentKeys.draft(id),
        queryFn: ({ signal }) => getAgentDraft(id, signal),
        enabled: Boolean(id),
        // The editor holds its own copy; a background refetch must not look
        // like someone else's edit arriving under the person's thumbs.
        staleTime: Infinity,
        refetchOnWindowFocus: false,
    });
}

/**
 * The concept as a detail screen reads it: `null` (404 — gone, or out of
 * reach, which the server answers alike) is an error, not "still loading".
 */
export function useAgentDraftDetail(id: string): DetailQuery<AgentDetail> {
    const query = useAgentDraft(id);
    return {
        data: query.data ?? undefined,
        isLoading: query.isLoading,
        isError: query.isError || query.data === null,
        error: query.error,
        refetch: query.refetch,
    };
}

/** Everything that shows an agent: its profile, the list, the tools. */
function invalidateAgent(queryClient: QueryClient, id: string): void {
    void queryClient.invalidateQueries({ queryKey: agentKeys.detail(id) });
    void queryClient.invalidateQueries({ queryKey: agentKeys.tools(id) });
    void queryClient.invalidateQueries({ queryKey: agentKeys.all });
}

export interface SaveVars {
    draft: AgentDraft;
    rev?: number;
    /** Only a refine sends one; undefined leaves the column alone. */
    persona?: Persona | null;
}

export function useSaveAgent(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ draft, rev, persona }: SaveVars) => updateAgent(id, savePayload(draft, rev, persona)),
        onSuccess: (saved) => {
            // The echo is the concept but not its publish counters (only GET
            // /:id works those out): keep the old ones until the refetch lands.
            queryClient.setQueryData<AgentDetail | null>(agentKeys.draft(id), (prev) => ({
                ...prev,
                ...saved,
                persona: saved.persona ?? prev?.persona,
                published_version: saved.published_version ?? prev?.published_version,
                unpublishedChanges: saved.unpublishedChanges ?? prev?.unpublishedChanges,
            }));
            void queryClient.invalidateQueries({ queryKey: agentKeys.draft(id) });
            invalidateAgent(queryClient, id);
        },
    });
}

export function useCreateAgent() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (draft: AgentDraft) => createAgent(createPayload(draft)),
        onSuccess: (created) => {
            if (created.id) queryClient.setQueryData(agentKeys.draft(created.id), created);
            void queryClient.invalidateQueries({ queryKey: agentKeys.all });
        },
    });
}

/** Who may use it — applied at once, as the web's capsule does, not with the draft. */
export function useAgentAudience(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { isPublished: boolean; sharedGroups: string[] }) => setAgentAudience(id, body),
        onSuccess: (_void, body) => {
            queryClient.setQueryData<AgentDetail | null>(agentKeys.draft(id), (prev) =>
                prev ? { ...prev, is_published: body.isPublished, shared_groups: body.sharedGroups } : prev,
            );
            invalidateAgent(queryClient, id);
        },
    });
}

export function usePublishVersion(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => publishAgentVersion(id),
        onSuccess: (answer) => {
            queryClient.setQueryData<AgentDetail | null>(agentKeys.draft(id), (prev) =>
                prev ? { ...prev, published_version: answer.publishedVersion ?? prev.published_version, unpublishedChanges: 0 } : prev,
            );
            invalidateAgent(queryClient, id);
        },
    });
}

/** Undo a refine: restore its pre_refine version, then re-read the concept. */
export function useRestoreVersion(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: async (versionId: string) => {
            await restoreAgentVersion(id, versionId);
            return getAgentDraft(id);
        },
        onSuccess: (fresh) => {
            if (fresh) queryClient.setQueryData(agentKeys.draft(id), fresh);
            invalidateAgent(queryClient, id);
        },
    });
}
