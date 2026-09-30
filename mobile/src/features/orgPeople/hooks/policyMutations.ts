/**
 * Writes on what the organisation's roles, tiers and grants allow: role
 * permissions, custom model tiers and capability grants.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { saveOrgCustomTiers, saveRolePermissions, setGroupAccess, setOrgAccess } from '../api/endpoints';
import { peopleKeys } from '../api/keys';
import { applyEveryone, applyGroup } from '../model/access';
import { withSavedRole } from '../model/roles';
import type { CustomTier, GroupAccess, OrgRoles } from '../model/types';

/**
 * Save the FULL editable choice for one role (not a delta, as on the web), and
 * splice what the server stored back into the cached mapping.
 */
export function useSaveRolePermissions() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ roleId, permissions }: { roleId: string; permissions: string[] }) =>
            saveRolePermissions(roleId, permissions),
        onSuccess: (stored, { roleId, permissions }) => {
            queryClient.setQueryData<OrgRoles>(peopleKeys.roles, (prev) =>
                prev
                    ? {
                          ...prev,
                          roles: withSavedRole(prev.roles, roleId, prev.editablePermissions, stored ?? permissions),
                      }
                    : prev,
            );
        },
    });
}

/** POST replaces the org's whole tier list; the answer is what was stored. */
export function useSaveOrgTiers() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (tiers: CustomTier[]) => saveOrgCustomTiers(tiers),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: peopleKeys.orgTiers });
            void queryClient.invalidateQueries({ queryKey: peopleKeys.customTiersList });
        },
    });
}

type AccessScope = { kind: 'everyone' } | { kind: 'group'; groupId: string };

/**
 * Replace one scope's grants. Optimistic, because a switch that waits for the
 * network before it moves reads as broken; a refusal restores the previous
 * payload and the re-read settles on what the server clamped to.
 */
export function useSetGrants(orgId: string | null) {
    const queryClient = useQueryClient();
    const key = peopleKeys.access(orgId ?? 'none');
    return useMutation({
        mutationFn: ({ scope, granted }: { scope: AccessScope; granted: string[] }) => {
            if (scope.kind === 'group') return setGroupAccess(scope.groupId, granted);
            if (!orgId) throw new Error('No organisation');
            return setOrgAccess(orgId, granted);
        },
        onMutate: async ({ scope, granted }) => {
            await queryClient.cancelQueries({ queryKey: key });
            const previous = queryClient.getQueryData<GroupAccess>(key);
            if (previous) {
                const next =
                    scope.kind === 'group'
                        ? applyGroup(previous, scope.groupId, granted)
                        : applyEveryone(previous, granted);
                queryClient.setQueryData(key, next);
            }
            return { previous };
        },
        onError: (_error, _vars, context) => {
            if (context?.previous) queryClient.setQueryData(key, context.previous);
        },
        onSettled: () => void queryClient.invalidateQueries({ queryKey: key }),
    });
}
