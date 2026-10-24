// Reads for notebook, moved out of components by scripts/rq-codemod.mjs.
// authFetch stays inside queryFn on purpose: the screens' tests mock authFetch.

import { useQuery } from '@tanstack/react-query';
import { authFetch, API_BASE } from '../../utils/helpers';

export const notebookKeys = {
    aiUserSettings: ['notebook', 'aiUserSettings'] as const,
    authAppPasswordStatus: ['notebook', 'authAppPasswordStatus'] as const,
};

export function useAiUserSettings() {
    return useQuery<boolean, Error>({
        queryKey: notebookKeys.aiUserSettings,
        queryFn: async () => {
            const r = await authFetch(`${API_BASE}/ai/user-settings`);
            const d = r.ok ? await r.json() : {};
            return !!d.hasSignRequestConfig;
        },
        staleTime: 0,
        retry: false,
    });
}

export function useAuthAppPasswordStatus() {
    return useQuery<boolean, Error>({
        queryKey: notebookKeys.authAppPasswordStatus,
        queryFn: async () => {
            const r = await authFetch(`${API_BASE}/auth/app-password-status`);
            const d = r.ok ? await r.json() : {};
            return !!d.hasAppPassword;
        },
        staleTime: 0,
        retry: false,
    });
}
