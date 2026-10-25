// The org-level switches the chat composer reads from /ai/user-settings (which tool buttons
// to offer, how the search behaves on upload). authFetch stays inside queryFn on purpose:
// the composer tests mock it. A refused answer or a network failure keeps the defaults.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export interface ComposerOrgSettings {
    /** null = no org restriction known (everything is on). */
    orgEnabledIntegrations: string[] | null;
    hasGoogleKey: boolean;
    hasElevenLabsKey: boolean;
    disableSearchOnUpload: boolean;
    searchProvider: string;
}

const DEFAULTS: ComposerOrgSettings = {
    orgEnabledIntegrations: null,
    hasGoogleKey: false,
    hasElevenLabsKey: false,
    disableSearchOnUpload: false,
    searchProvider: 'agent-search',
};

export function useComposerOrgSettings(): ComposerOrgSettings {
    const { data } = useQuery<ComposerOrgSettings, Error>({
        queryKey: ['composer', 'orgSettings'],
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/ai/user-settings`);
                const d = r.ok ? await r.json() : null;
                if (!d) return DEFAULTS;
                return {
                    orgEnabledIntegrations: d.orgEnabledIntegrations !== undefined ? d.orgEnabledIntegrations : DEFAULTS.orgEnabledIntegrations,
                    hasGoogleKey: d.hasGoogleKey !== undefined ? d.hasGoogleKey : DEFAULTS.hasGoogleKey,
                    hasElevenLabsKey: d.hasElevenLabsKey !== undefined ? d.hasElevenLabsKey : DEFAULTS.hasElevenLabsKey,
                    disableSearchOnUpload: !!d.disableSearchOnUpload,
                    searchProvider: d.searchProvider || DEFAULTS.searchProvider,
                };
            } catch {
                return DEFAULTS;
            }
        },
        staleTime: 0,
        retry: false,
    });
    return data ?? DEFAULTS;
}
