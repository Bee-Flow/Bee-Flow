// The org-level switches the chat composer reads from /ai/user-settings (which tool buttons
// to offer, how the search behaves on upload). authFetch stays inside queryFn on purpose:
// the composer tests mock it. A refused answer or a network failure keeps the defaults.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';
import { toImageQuota, type ImageQuota } from '../../utils/imageLimits';

/** One image model the user can pick: a Google model id, or `azure/<deployment>`. */
export interface ImageModelOption {
    id: string;
    label: string;
    provider?: 'google' | 'azure';
}

export interface ComposerOrgSettings {
    /** null = no org restriction known (everything is on). */
    orgEnabledIntegrations: string[] | null;
    /** Music and video generation still need the Google key. */
    hasGoogleKey: boolean;
    /** At least one image model (Google or an Azure deployment) is configured. */
    hasImageGen: boolean;
    /** The image models the server offers; null when it sent no list (an older server). */
    imageModels: ImageModelOption[] | null;
    /** The user's image limits and what is used; null without a limit. */
    imageQuota: ImageQuota | null;
    hasElevenLabsKey: boolean;
    disableSearchOnUpload: boolean;
    searchProvider: string;
}

export const COMPOSER_ORG_SETTINGS_KEY = ['composer', 'orgSettings'] as const;

const DEFAULTS: ComposerOrgSettings = {
    orgEnabledIntegrations: null,
    hasGoogleKey: false,
    hasImageGen: false,
    imageModels: null,
    imageQuota: null,
    hasElevenLabsKey: false,
    disableSearchOnUpload: false,
    searchProvider: 'agent-search',
};

/** The server's model list, keeping only well-formed entries; null when there is no list. */
function toImageModels(value: unknown): ImageModelOption[] | null {
    if (!Array.isArray(value)) return null;
    return value.flatMap((m): ImageModelOption[] => {
        if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !m.id) return [];
        const provider = m.provider === 'google' || m.provider === 'azure' ? m.provider : undefined;
        return [{ id: m.id, label: typeof m.label === 'string' && m.label ? m.label : m.id, ...(provider ? { provider } : {}) }];
    });
}

export function useComposerOrgSettings(): ComposerOrgSettings {
    const { data } = useQuery<ComposerOrgSettings, Error>({
        queryKey: COMPOSER_ORG_SETTINGS_KEY,
        queryFn: async () => {
            try {
                const r = await authFetch(`${API_BASE}/ai/user-settings`);
                const d = r.ok ? await r.json() : null;
                if (!d) return DEFAULTS;
                const hasGoogleKey = d.hasGoogleKey !== undefined ? d.hasGoogleKey : DEFAULTS.hasGoogleKey;
                return {
                    orgEnabledIntegrations: d.orgEnabledIntegrations !== undefined ? d.orgEnabledIntegrations : DEFAULTS.orgEnabledIntegrations,
                    hasGoogleKey,
                    // A server without the flag only generated images with the Google key.
                    hasImageGen: d.hasImageGen !== undefined ? !!d.hasImageGen : !!hasGoogleKey,
                    imageModels: toImageModels(d.imageModels),
                    imageQuota: toImageQuota(d.imageQuota),
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
