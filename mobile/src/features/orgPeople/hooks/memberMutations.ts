/**
 * Writes on members and invitations. Each ends by re-reading the roster, the
 * way every write on the web ends in `fetchData`, so no two screens disagree
 * about the same person.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
    createInvitation,
    deleteMember,
    resetMemberMfa,
    revokeInvitation,
    updateMember,
    type MemberPatch,
} from '../api/endpoints';
import { ORG_ROSTER_KEYS, peopleKeys } from '../api/keys';

/** The roster and group lists here and in features/org. */
export function invalidateRoster(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ queryKey: peopleKeys.members });
    void queryClient.invalidateQueries({ queryKey: peopleKeys.groups });
    for (const key of ORG_ROSTER_KEYS) void queryClient.invalidateQueries({ queryKey: key });
}

export function useUpdateMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ id, patch }: { id: string; patch: MemberPatch }) => updateMember(id, patch),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

/**
 * Let a pending sign-up in. The body is the web's (useOrgMemberRoles
 * handleApproveUser): `status` and `orgRole` are both on the server's
 * allow-list, and 'user' is the plain, no-org-role member.
 */
export function useApproveMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => updateMember(id, { status: 'active', orgRole: 'user' }),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

/** Reject a pending sign-up, or remove a member: the same DELETE. */
export function useDeleteMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteMember(id),
        onSuccess: () => invalidateRoster(queryClient),
    });
}

export function useResetMemberMfa() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => resetMemberMfa(id),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: peopleKeys.members }),
    });
}

export function useInviteMember() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { email: string; role?: string }) => createInvitation(body),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: peopleKeys.invitations }),
    });
}

export function useRevokeInvitation() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => revokeInvitation(id),
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: peopleKeys.invitations }),
    });
}
