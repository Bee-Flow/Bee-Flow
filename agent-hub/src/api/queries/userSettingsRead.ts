// The person's own settings (GET /ai/user-settings), read where one flag
// decides something once: e.g. whether the intro tour already ran. null when
// the server did not answer ok.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { userSettingsApi } from '../userSettingsApi';

export function useUserSettingsRead<S>() {
    const qc = useQueryClient();
    return useCallback(() => qc.fetchQuery<S | null>({
        queryKey: ['user-settings', 'once'],
        queryFn: async () => {
            const res = await userSettingsApi.get();
            return res.ok ? (await res.json()) as S : null;
        },
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}
