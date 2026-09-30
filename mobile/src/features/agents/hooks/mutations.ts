/**
 * Agents' writes. Each mutation owns its invalidation (and its optimistic
 * update), with the same keys the screens used to spell out.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

import { deleteAgentConversation, setFavorite, updateAgentConversation } from '../api/endpoints';
import { agentKeys } from '../api/keys';

/**
 * Star or unstar an agent. Optimistic — the star has to move on the tap — and
 * both directions are idempotent server-side, so a lost round-trip costs
 * nothing but a stale star until the next refetch.
 */
export function useToggleFavorite() {
    const queryClient = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: ({ id, next }: { id: string; next: boolean }) => setFavorite(id, next),
        onMutate: async ({ id, next }) => {
            await queryClient.cancelQueries({ queryKey: agentKeys.favorites });
            const previous = queryClient.getQueryData<string[]>(agentKeys.favorites) ?? [];
            queryClient.setQueryData<string[]>(
                agentKeys.favorites,
                next ? [...previous, id] : previous.filter((v) => v !== id),
            );
            return { previous };
        },
        onError: (_err, _vars, context) => {
            if (context?.previous) queryClient.setQueryData(agentKeys.favorites, context.previous);
            toast('That favourite did not save', 'error');
        },
        onSettled: () => {
            void queryClient.invalidateQueries({ queryKey: agentKeys.favorites });
        },
    });
}

/**
 * The agent's list and the cross-agent one: they show the same rows, and
 * leaving the latter stale keeps a deleted conversation on the Agents screen.
 */
function invalidateConversations(queryClient: QueryClient, agentId: string): void {
    void queryClient.invalidateQueries({ queryKey: agentKeys.conversations(agentId) });
    void queryClient.invalidateQueries({ queryKey: agentKeys.allConversations });
}

/** After a streamed turn: the server is the source of truth for what was stored. */
export function invalidateAfterAgentTurn(
    queryClient: QueryClient,
    agentId: string,
    conversationId: string | null,
): void {
    invalidateConversations(queryClient, agentId);
    if (conversationId) {
        void queryClient.invalidateQueries({ queryKey: agentKeys.conversation(agentId, conversationId) });
    }
}

/**
 * Pin, rename and delete for one agent's conversations. A failed pin or
 * delete toasts the reason (describeError's words); a failed rename does not,
 * because its sheet is still open and shows it there.
 */
export function useAgentConversationActions(agentId: string) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const invalidate = () => invalidateConversations(queryClient, agentId);
    const failed = (err: unknown) => toast(describeError(err).message, 'error');

    const pin = useMutation({
        mutationFn: ({ conversationId, pinned }: { conversationId: string; pinned: boolean }) =>
            updateAgentConversation(agentId, conversationId, { pinned }),
        onSuccess: invalidate,
        onError: failed,
    });

    const rename = useMutation({
        mutationFn: ({ conversationId, title }: { conversationId: string; title: string }) =>
            updateAgentConversation(agentId, conversationId, { title }),
        onSuccess: invalidate,
    });

    const remove = useMutation({
        mutationFn: (conversationId: string) => deleteAgentConversation(agentId, conversationId),
        onSuccess: () => {
            invalidate();
            toast(t('mobile.agents.conversation_deleted', 'Conversation deleted'));
        },
        onError: failed,
    });

    return { pin, rename, remove };
}
