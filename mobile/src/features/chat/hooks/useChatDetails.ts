/**
 * Everything the chat details screen can READ and DO, without any of its markup.
 *
 * The queries and mutations are the feature's own (queries.ts, mutations.ts);
 * this composes them with the two drafts the screen keeps — the rename field
 * and the new-label field — so the screen is only the rendering.
 *
 * The hook does not theme: `destroy` is the one write that navigates, because
 * "delete this conversation" has nowhere to return to and the unwind is part
 * of the operation rather than a reaction to it. It pops this screen and the
 * chat under it, back to wherever the chat was opened from
 * (model/deletedChat.ts).
 */

import { useNavigation, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';

import { useProjects } from '@/features/projects';

import {
    useCreateLabel,
    useDeleteConversation,
    useDeleteLabel,
    useMoveToProject,
    useShareToProject,
    usePatchConversation,
    useRegenerateSessionSkills,
    useRemoveSessionSkill,
    useRenameLabel,
} from './mutations';
import { CHOICE_LIST_STALE_MS, useConversation, useLabels, useSessionSkills } from './queries';
import { leaveDeletedChat } from '../model/deletedChat';
import { parseLabels } from '../model/labels';

/**
 * The rename field is `null` until the user types, and the server's title
 * shows through until then. Deriving it this way rather than seeding state
 * from an effect means a title that changes underneath (the server names a
 * chat from its first message, asynchronously) is picked up automatically,
 * and a half-typed rename is never overwritten by a refetch.
 */
function useTitleDraft(serverTitle: string, patch: ReturnType<typeof usePatchConversation>) {
    const [draftTitle, setDraftTitle] = useState<string | null>(null);
    const title = draftTitle ?? serverTitle;
    // Only the rename drops the draft — a pin toggle or a label tap goes
    // through the same mutation and must not clear a half-typed name.
    const saveTitle = () => {
        patch.mutate({ title: title.trim() }, { onSuccess: () => setDraftTitle(null) });
    };
    return { title, setDraftTitle, saveTitle };
}

function useLabelEditing(conversationId: string, appliedLabelIds: string[], patch: ReturnType<typeof usePatchConversation>) {
    const [newLabel, setNewLabel] = useState('');
    const [editingLabelId, setEditingLabelId] = useState<string | null>(null);
    // A label created from here is meant for THIS chat — creating it and then
    // making the user tap it again is a pointless second step.
    const addLabel = useCreateLabel({
        cleared: () => setNewLabel(''),
        ready: (id) => patch.mutate({ labels: [...appliedLabelIds, id] }),
    });
    const renameLabel = useRenameLabel(() => setEditingLabelId(null));
    const dropLabel = useDeleteLabel(conversationId);
    return { newLabel, setNewLabel, editingLabelId, setEditingLabelId, addLabel, renameLabel, dropLabel };
}

/** Off the screens of a conversation that was just deleted, read from the stack as it is then. */
function useLeaveDeletedChat(conversationId: string): () => void {
    const router = useRouter();
    const navigation = useNavigation();
    return () => leaveDeletedChat(router, navigation.getState()?.routes ?? [], conversationId);
}

export function useChatDetails(conversationId: string) {
    const conversationQuery = useConversation(conversationId);
    const labelsQuery = useLabels();
    const projectsQuery = useProjects({ staleTime: CHOICE_LIST_STALE_MS });
    const skillsQuery = useSessionSkills(conversationId);

    const conversation = conversationQuery.data ?? null;
    const serverTitle = conversation?.title ?? '';
    const appliedLabelIds = useMemo(() => parseLabels(conversation?.labels_json), [conversation?.labels_json]);

    const patch = usePatchConversation(conversationId);
    const { title, setDraftTitle, saveTitle } = useTitleDraft(serverTitle, patch);
    const labels = useLabelEditing(conversationId, appliedLabelIds, patch);
    const moveToProject = useMoveToProject(conversationId);
    const shareToProject = useShareToProject(conversationId);
    const regenerate = useRegenerateSessionSkills(conversationId);
    const dropSkill = useRemoveSessionSkill(conversationId);
    const leave = useLeaveDeletedChat(conversationId);
    const destroy = useDeleteConversation(conversationId, { onDeleted: leave });

    /** The first error any write reported, or null. One banner, not nine. */
    const failure =
        patch.error ??
        labels.addLabel.error ??
        labels.renameLabel.error ??
        labels.dropLabel.error ??
        moveToProject.error ??
        shareToProject.error ??
        regenerate.error ??
        dropSkill.error ??
        destroy.error ??
        null;

    return {
        conversationQuery,
        labelsQuery,
        projectsQuery,
        skillsQuery,
        conversation,
        title,
        /** The server's title, so the screen can tell an untouched name from an edited one. */
        serverTitle,
        appliedLabelIds,
        failure,
        // The rename draft: `title` already folds it in, so only the setter leaves.
        setDraftTitle,
        ...labels,
        patch,
        saveTitle,
        moveToProject,
        shareToProject,
        regenerate,
        dropSkill,
        destroy,
    };
}

export type ChatDetails = ReturnType<typeof useChatDetails>;
