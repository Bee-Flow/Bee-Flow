// The voice-chat readiness read (/ai/config), moved out of useVoiceChatReady.
// A non-ok answer or a network failure is the state "not ready", never an exception.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../utils/helpers';

export function useVoiceChatConfigReady(enabled: boolean) {
    return useQuery<boolean, Error>({
        queryKey: ['voiceChat', 'configReady'],
        enabled,
        queryFn: async () => {
            try {
                const resp = await authFetch(`${API_BASE}/ai/config`);
                if (!resp.ok) return false;
                const cfg = await resp.json();
                return !!cfg.voiceChatReady;
            } catch (_) {
                return false;
            }
        },
        staleTime: 0,
        retry: false,
    });
}
