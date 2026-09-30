/** Organisation-side writes: the user's shield, and filing a data request. */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { saveUserShield, submitDsrRequest, updateOrganization } from '../api/endpoints';
import { orgKeys } from '../api/keys';
import type { Organization, OrgPatch, UserShield } from '../model/types';

/**
 * Save the whole shield document.
 *
 * PUT /user/me replaces the stored config rather than patching it — every
 * field is read off `req.body` and defaulted if absent — so a partial send
 * would silently reset the omitted ones. Callers spread the current document
 * first. `onSaved` runs after EVERY save, not only the last of a quick run of
 * toggles, which is why it is an option here rather than a mutate callback.
 */
export function useSaveUserShield({ onSaved }: { onSaved?: () => void } = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (next: UserShield) => saveUserShield(next),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: orgKeys.userShield });
            onSaved?.();
        },
    });
}

export function useSubmitDsrRequest() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: { subject_email: string; request_type: string; notes?: string }) =>
            submitDsrRequest(body),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: orgKeys.dsr });
        },
    });
}

/**
 * Patch the organisation record. Every org section that edits a field of it
 * (profile, sign-in, auto-approve, pooled usage) goes through this one hook,
 * so the record and the index's derived rows refresh together. The saved
 * keys are written into the cached record at once (the PUT answers only
 * `{ success }`), so a form that drops its edits after the save shows the
 * new values rather than flashing the old ones until the refetch lands.
 */
export function useUpdateOrganization(orgId: string | null) {
    const queryClient = useQueryClient();
    const key = orgKeys.org(orgId ?? 'none');
    return useMutation({
        mutationFn: (patch: OrgPatch) => {
            if (!orgId) throw new Error('No organisation');
            return updateOrganization(orgId, patch);
        },
        onSuccess: (_result, patch) => {
            queryClient.setQueryData<Organization | null>(key, (old) => (old ? { ...old, ...patch } : old));
            void queryClient.invalidateQueries({ queryKey: key });
        },
    });
}
