// A settings read whose failure is a STATE, not an exception: a non-ok answer
// (403/404: the feature is not licensed for this account) or a network failure
// resolves to `null`, which the section renders as "hide yourself". This is the
// shape of the effect the Settings sections used to hand-write around authFetch.
// `isPending` is true only until the first answer, so a refetch (after a save)
// never flashes the section away.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export const settingsOptionalKeys = {
    talkNotes: ['settings', 'talk-notes-user'] as const,
    gmeetNotes: ['settings', 'gmeet-notes-user'] as const,
    voiceprint: ['settings', 'voiceprint-availability'] as const,
};

function useOptionalSettings<T>(queryKey: readonly unknown[], path: string) {
    return useQuery<T | null, Error>({
        queryKey,
        queryFn: async () => {
            try {
                const res = await authFetch(`${API_BASE}${path}`);
                return res.ok ? ((await res.json()) as T) : null;
            } catch {
                return null;
            }
        },
        staleTime: 0,
        retry: false,
    });
}

/** GET /api/talk-notes-settings/user/me */
export const useTalkNotesUserSettings = <T,>() => useOptionalSettings<T>(settingsOptionalKeys.talkNotes, '/api/talk-notes-settings/user/me');
/** GET /api/gmeet-notes-settings/user/me */
export const useGmeetNotesUserSettings = <T,>() => useOptionalSettings<T>(settingsOptionalKeys.gmeetNotes, '/api/gmeet-notes-settings/user/me');
/** GET /api/voiceprints/availability */
export const useVoiceprintAvailability = <T,>() => useOptionalSettings<T>(settingsOptionalKeys.voiceprint, '/api/voiceprints/availability');
