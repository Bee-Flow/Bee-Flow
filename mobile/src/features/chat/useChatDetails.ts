/**
 * Everything the chat details screen can READ and DO, without any of its markup.
 *
 * The screen was 877 lines because it held three concerns at once: nine
 * queries and mutations, the rename draft, and the rendering of a dozen
 * sections. Only the last of those is what a reader opens a screen file to
 * find, and only the first two are what breaks. They live here now, so a
 * change to the label flow is a change to one 160-line file rather than a
 * search through a screen.
 *
 * The hook does not navigate and does not theme: `destroy` is the one
 * exception, because "delete this conversation" has nowhere to return to and
 * the unwind is part of the operation rather than a reaction to it.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import {
    assignToProject,
    chatKeys,
    createLabel,
    deleteConversation,
    deleteLabel,
    detachFromProject,
    getConversation,
    getSessionSkills,
    listLabels,
    parseLabels,
    regenerateSessionSkills,
    removeSessionSkill,
    updateConversation,
    updateLabel,
} from './api';
import { useToast } from '../../ui/Toast';
import { automateKeys, listProjects } from '../automate/api';

export function useChatDetails(conversationId: string) {
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();

    /**
     * The rename field is `null` until the user types, and the server's title
     * shows through until then. Deriving it this way rather than seeding state
     * from an effect means a title that changes underneath (the server names a
     * chat from its first message, asynchronously) is picked up automatically,
     * and a half-typed rename is never overwritten by a refetch.
     */
    const [draftTitle, setDraftTitle] = useState<string | null>(null);
    const [newLabel, setNewLabel] = useState('');
    const [editingLabelId, setEditingLabelId] = useState<string | null>(null);

    const conversationQuery = useQuery({
        queryKey: chatKeys.conversation(conversationId),
        queryFn: ({ signal }) => getConversation(conversationId, signal),
        enabled: Boolean(conversationId),
    });

    const labelsQuery = useQuery({
        queryKey: chatKeys.labels,
        queryFn: ({ signal }) => listLabels(signal),
        staleTime: 5 * 60_000,
    });

    const projectsQuery = useQuery({
        queryKey: automateKeys.projects,
        queryFn: ({ signal }) => listProjects(signal),
        staleTime: 5 * 60_000,
    });

    /**
     * Session skills only exist on a Standard-tier conversation, and the route
     * is behind the same tier config. A failure here hides the section rather
     * than shouting: a chat without skills is the normal case, not an error.
     */
    const skillsQuery = useQuery({
        queryKey: chatKeys.sessionSkills(conversationId),
        queryFn: ({ signal }) => getSessionSkills(conversationId, signal),
        enabled: Boolean(conversationId),
        retry: false,
    });

    const conversation = conversationQuery.data ?? null;
    const serverTitle = conversation?.title ?? '';
    const title = draftTitle ?? serverTitle;

    const appliedLabelIds = useMemo(
        () => parseLabels(conversation?.labels_json),
        [conversation?.labels_json],
    );

    const invalidateConversation = () => {
        void queryClient.invalidateQueries({ queryKey: chatKeys.conversation(conversationId) });
        // The list screen shows the title, the pin and the labels, so it is
        // stale the moment any of them change.
        void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
    };

    const patch = useMutation({
        mutationFn: (body: { title?: string; pinned?: boolean; labels?: string[] }) =>
            updateConversation(conversationId, body),
        onSuccess: invalidateConversation,
    });

    // Only the rename drops the draft — a pin toggle or a label tap goes
    // through the same mutation and must not clear a half-typed name.
    const saveTitle = useCallback(() => {
        patch.mutate({ title: title.trim() }, { onSuccess: () => setDraftTitle(null) });
    }, [patch, title]);

    const addLabel = useMutation({
        mutationFn: (name: string) => createLabel(name),
        onSuccess: async (created) => {
            setNewLabel('');
            await queryClient.invalidateQueries({ queryKey: chatKeys.labels });
            // A label created from here is meant for THIS chat — creating it
            // and then making the user tap it again is a pointless second step.
            if (created?.id) patch.mutate({ labels: [...appliedLabelIds, created.id] });
        },
    });

    const renameLabel = useMutation({
        mutationFn: ({ labelId, name }: { labelId: string; name: string }) =>
            updateLabel(labelId, { name }),
        onSuccess: () => {
            setEditingLabelId(null);
            void queryClient.invalidateQueries({ queryKey: chatKeys.labels });
        },
    });

    const dropLabel = useMutation({
        mutationFn: (labelId: string) => deleteLabel(labelId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: chatKeys.labels });
            invalidateConversation();
            toast('Label deleted', 'success');
        },
    });

    const moveToProject = useMutation({
        mutationFn: (projectId: string | null) =>
            projectId ? assignToProject(projectId, conversationId) : detachFromProject(conversationId),
        onSuccess: (_result, projectId) => {
            toast(projectId ? 'Moved to project' : 'Removed from project', 'success');
            invalidateConversation();
            void queryClient.invalidateQueries({ queryKey: automateKeys.projects });
        },
    });

    const regenerate = useMutation({
        mutationFn: () => regenerateSessionSkills(conversationId),
        onSuccess: () => {
            toast('Skills regenerated', 'success');
            void queryClient.invalidateQueries({ queryKey: chatKeys.sessionSkills(conversationId) });
        },
    });

    const dropSkill = useMutation({
        mutationFn: (skillId: string) => removeSessionSkill(conversationId, skillId),
        onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: chatKeys.sessionSkills(conversationId) }),
    });

    const destroy = useMutation({
        mutationFn: () => deleteConversation(conversationId),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: chatKeys.conversations });
            queryClient.removeQueries({ queryKey: chatKeys.conversation(conversationId) });
            toast('Conversation deleted', 'success');
            // This screen AND the chat behind it are both gone, so going
            // "back" would land on a 404. Unwind the stack when there is one
            // to unwind, then land on the chat list.
            if (router.canDismiss()) router.dismissAll();
            router.replace('/(tabs)');
        },
    });

    const failure =
        patch.error ??
        addLabel.error ??
        renameLabel.error ??
        dropLabel.error ??
        moveToProject.error ??
        regenerate.error ??
        dropSkill.error ??
        destroy.error ??
        null;


    return {
        // Reads
        conversationQuery,
        labelsQuery,
        projectsQuery,
        skillsQuery,
        conversation,
        title,
        /** The server's title, so the screen can tell an untouched name from an edited one. */
        serverTitle,
        appliedLabelIds,
        /** The first error any write reported, or null. One banner, not nine. */
        failure,
        // The rename draft. `title` above already folds it in, so only the
        // setters leave: the screen writes the draft, it never re-reads it.
        setDraftTitle,
        newLabel,
        setNewLabel,
        editingLabelId,
        setEditingLabelId,
        // Writes
        patch,
        saveTitle,
        addLabel,
        renameLabel,
        dropLabel,
        moveToProject,
        regenerate,
        dropSkill,
        destroy,
    };
}
