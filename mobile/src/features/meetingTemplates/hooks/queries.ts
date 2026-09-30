/** Summary-template reads and writes. Screens call these, never useQuery. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import {
    createSummaryTemplate,
    deleteSummaryTemplate,
    listSummaryTemplates,
    listOrgTemplates,
    updateSummaryTemplate,
} from '../api/endpoints';
import { templateKeys } from '../api/keys';
import type { TemplateDraft } from '../model/types';

/**
 * The templates. `enabled` lets the Regenerate sheet fetch only while it is
 * open; the list barely changes, so it stays fresh for five minutes.
 */
export function useSummaryTemplates(enabled = true) {
    return useQuery({
        queryKey: templateKeys.list,
        queryFn: ({ signal }) => listSummaryTemplates(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

/** The org's org and group templates and its groups, asked only of an org admin (anyone else gets a 403). */
export function useOrgTemplates(enabled: boolean) {
    return useQuery({
        queryKey: templateKeys.org,
        queryFn: ({ signal }) => listOrgTemplates(signal),
        enabled,
        staleTime: 5 * 60_000,
    });
}

/** Create (no id) or update (an id). Either way both lists are re-read. */
export function useSaveTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, draft }: { id: string | null; draft: TemplateDraft }) =>
            id ? updateSummaryTemplate(id, draft) : createSummaryTemplate(draft),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: templateKeys.all }),
    });
}

export function useDeleteTemplate() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteSummaryTemplate(id),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: templateKeys.all }),
    });
}
