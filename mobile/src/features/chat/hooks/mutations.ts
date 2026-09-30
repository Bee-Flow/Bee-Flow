/**
 * Chat's writes. Each mutation owns its invalidation, with the same keys the
 * screens used to spell out, so a change to what goes stale is one edit here.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useTranslation } from '@/core/i18n';
import { invalidateProjectList } from '@/features/projects';
import { useToast } from '@/shared/ui';

import {
    assignToProject,
    createLabel,
    deleteConversation,
    deleteLabel,
    detachFromProject,
    regenerateSessionSkills,
    removeSessionSkill,
    updateConversation,
    updateLabel,
    shareToProject,
    unshareFromProject,
} from '../api/endpoints';
import { chatKeys } from '../api/keys';
import { markDeleted } from '../model/deletedChat';

export interface ConversationPatch {
    title?: string;
    pinned?: boolean;
    labels?: string[];
}

/**
 * The conversation and the list: the list shows the title, the pin and the
 * labels, so it is stale the moment any of them change.
 */
export function invalidateConversation(queryClient: QueryClient, conversationId: string): void {
    void queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
    void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
}

/** After a streamed turn: the server is the source of truth for what was stored. */
export function invalidateAfterTurn(queryClient: QueryClient, conversationId: string | null): void {
    void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
    if (conversationId) void queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
}

/** Rename, pin and relabel — one PATCH, each control sending only its field. */
export function usePatchConversation(conversationId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: ConversationPatch) => updateConversation(conversationId, body),
        onSuccess: () => invalidateConversation(queryClient, conversationId),
    });
}

/** File into a project (`projectId`) or take it back out (`null`). */
export function useMoveToProject(conversationId: string) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: (projectId: string | null) =>
            projectId ? assignToProject(projectId, conversationId) : detachFromProject(conversationId),
        onSuccess: (_result, projectId) => {
            toast(
                projectId
                    ? t('mobile.chat.details.moved_to_project', 'Moved to project')
                    : t('mobile.chat.details.removed_from_project', 'Removed from project'),
                'success',
            );
            invalidateConversation(queryClient, conversationId);
            invalidateProjectList(queryClient);
        },
    });
}

/**
 * Share this conversation INTO its project as a thread, or take it back —
 * POST/DELETE /api/projects/:id/threads (owner only; the server re-keys the
 * transcript to the organisation's key on the way in, which is why the
 * screen asks first).
 */
export function useShareToProject(conversationId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ projectId, share }: { projectId: string; share: boolean }) =>
            share ? shareToProject(projectId, conversationId) : unshareFromProject(projectId, conversationId),
        onSuccess: () => {
            invalidateConversation(queryClient, conversationId);
            invalidateProjectList(queryClient);
        },
    });
}

/**
 * Delete a conversation. A list that deletes one of its rows (the drawer)
 * stays where it is — as the web sidebar does, which navigates only when the
 * chat it deleted was the one open. A screen that shows THAT conversation is
 * gone with it and passes `onDeleted` to leave (useChatDetails does, through
 * model/deletedChat.ts).
 */
export function useDeleteConversation(conversationId: string, { onDeleted }: { onDeleted?: () => void } = {}) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: () => deleteConversation(conversationId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
            queryClient.removeQueries({ queryKey: chatKeys.conversation(conversationId) });
            toast(t('mobile.chat.conversation_deleted', 'Conversation deleted'), 'success');
            // Before the leave: a chat still answering under it lets go without asking.
            markDeleted(conversationId);
            onDeleted?.();
        },
    });
}

/**
 * Create a label. `onCreated` runs before the label list refetches (to clear
 * the draft) and receives the new label once it has (to apply it).
 */
export function useCreateLabel(onCreated: { cleared: () => void; ready: (id: string) => void }) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (name: string) => createLabel(name),
        onSuccess: async (created) => {
            onCreated.cleared();
            await queryClient.invalidateQueries({ queryKey: chatKeys.labels });
            if (created?.id) onCreated.ready(created.id);
        },
    });
}

export function useRenameLabel(onRenamed: () => void) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ labelId, name }: { labelId: string; name: string }) => updateLabel(labelId, { name }),
        onSuccess: () => {
            onRenamed();
            void queryClient.invalidateQueries({ queryKey: chatKeys.labels });
        },
    });
}

/** Labels are global to the user: deleting one takes it off every chat. */
export function useDeleteLabel(conversationId: string) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: (labelId: string) => deleteLabel(labelId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: chatKeys.labels });
            invalidateConversation(queryClient, conversationId);
            toast(t('mobile.chat.details.label_deleted', 'Label deleted'), 'success');
        },
    });
}

export function useRegenerateSessionSkills(conversationId: string) {
    const t = useTranslation();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    return useMutation({
        mutationFn: () => regenerateSessionSkills(conversationId),
        onSuccess: () => {
            toast(t('mobile.chat.details.skills_regenerated', 'Skills regenerated'), 'success');
            void queryClient.invalidateQueries({ queryKey: chatKeys.sessionSkills(conversationId) });
        },
    });
}

export function useRemoveSessionSkill(conversationId: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (skillId: string) => removeSessionSkill(conversationId, skillId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: chatKeys.sessionSkills(conversationId) }),
    });
}
