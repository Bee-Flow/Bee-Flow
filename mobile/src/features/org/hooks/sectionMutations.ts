/**
 * Writes for the org-admin settings sections. Every one refreshes the query
 * its screen reads before it resolves, so a screen that awaits `mutateAsync`
 * and then drops its edits shows the server's new values, not the old ones.
 * None retries (see RequestOptions.retry).
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';

import { activateIconPack, saveOrgTheme } from '../api/branding';
import { APP_BRANDING_KEY, orgKeys } from '../api/keys';
import { purgeOrgIntegrationCache, saveOrgAiContext, saveOrgEncryption, saveOrgIntegrationCache } from '../api/policies';
import { deleteOrgLogo, setOrgDefaultLanguage, uploadOrgLogo, type LogoFile } from '../api/profile';
import type { AiContextBody, IntegrationCacheBody } from '../model/sectionTypes';
import type { OrgTheme } from '../model/theme';

function requireOrg(orgId: string | null): string {
    if (!orgId) throw new Error('No organisation');
    return orgId;
}

export function useUploadOrgLogo(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (file: LogoFile) => uploadOrgLogo(requireOrg(orgId), file),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.org(orgId ?? 'none') }),
    });
}

export function useDeleteOrgLogo(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => deleteOrgLogo(requireOrg(orgId)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.org(orgId ?? 'none') }),
    });
}

export function useSetOrgDefaultLanguage() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (code: string) => setOrgDefaultLanguage(code),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.languages }),
    });
}

export function useSaveOrgEncryption(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (tier: string) => saveOrgEncryption(requireOrg(orgId), tier),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.encryption(orgId ?? 'none') }),
    });
}

export function useSaveOrgAiContext(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: AiContextBody) => saveOrgAiContext(requireOrg(orgId), body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.aiContext(orgId ?? 'none') }),
    });
}

export function useSaveOrgIntegrationCache(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (body: IntegrationCacheBody) => saveOrgIntegrationCache(requireOrg(orgId), body),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.integrationCache(orgId ?? 'none') }),
    });
}

export function usePurgeOrgIntegrationCache(orgId: string | null) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: () => purgeOrgIntegrationCache(requireOrg(orgId)),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.integrationCache(orgId ?? 'none') }),
    });
}

/** Saves the changed knobs, then repaints the app in the organisation's new theme. */
export function useSaveOrgTheme() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (patch: Partial<OrgTheme>) => saveOrgTheme(patch),
        onSuccess: async (saved) => {
            queryClient.setQueryData(orgKeys.theme, saved);
            await queryClient.invalidateQueries({ queryKey: APP_BRANDING_KEY });
        },
    });
}

export function useActivateIconPack() {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (packId: string | null) => activateIconPack(packId),
        onSuccess: () => queryClient.invalidateQueries({ queryKey: orgKeys.iconPacks }),
    });
}
