// GET /ai/config: the admin AI settings as one JSON object (per-provider
// has-flags and plain values). Every card of the AI configuration reads its own
// keys from the same answer, so they share one cache entry and one request. A
// refusal reads as null (the cards keep their defaults); a network failure is an
// error.

import { useQuery } from '@tanstack/react-query';
import { API_BASE } from '../../utils/helpers';
import { readOrNull } from './refusableRead';

export const aiConfigKey = ['ai-config', 'admin'] as const;

/** The answer with a number that changes on every real read, so a consumer can tell a read from a local patch. */
export interface AiConfigRead<T> { config: T | null; read: number }

let reads = 0;

export function useAiConfigQuery<T extends object = Record<string, unknown>>() {
    return useQuery<AiConfigRead<T>, Error>({
        queryKey: aiConfigKey,
        queryFn: async ({ signal }) => ({ config: await readOrNull<T>(`${API_BASE}/ai/config`, signal), read: ++reads }),
        staleTime: 0,
        retry: false,
    });
}
