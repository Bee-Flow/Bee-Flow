/** Writes on groups and their membership (the web's useOrgGroups). */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { invalidateRoster } from './memberMutations';
import {
    addGroupMember,
    createGroup,
    deleteGroup,
    removeGroupMember,
    updateGroup,
    type GroupPatch,
} from '../api/endpoints';

export function useCreateGroup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { name: string; description: string; organizationId: string | null }) =>
            createGroup(body),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

export function useUpdateGroup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: GroupPatch }) => updateGroup(id, patch),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

export function useDeleteGroup() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteGroup(id),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

/** Add (`on`) or remove one member, from the group's side. */
export function useSetGroupMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ groupId, userId, on }: { groupId: string; userId: string; on: boolean }) =>
            on ? addGroupMember(groupId, userId) : removeGroupMember(groupId, userId),
        onSuccess: () => invalidateRoster(queryClient),
    });
}
