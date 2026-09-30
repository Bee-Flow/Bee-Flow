/** Voice's one read: whether this server can do voice at all. */

import { useQuery } from '@tanstack/react-query';

import { getAvailability } from '../api/endpoints';
import { voiceKeys } from '../api/keys';

/**
 * Whether the server has a speech provider configured changes about once a
 * quarter; re-asking on every focus would be pure noise.
 */
export function useVoiceAvailability() {
    return useQuery({
        queryKey: voiceKeys.availability,
        queryFn: ({ signal }) => getAvailability(signal),
        staleTime: 5 * 60_000,
    });
}
