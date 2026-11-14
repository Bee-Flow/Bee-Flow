// The automation builder's saved session (chat, draft, summary) for one
// automation, read once when the builder opens it so a refresh or a dropped
// stream does not lose the conversation. null when there is none.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { fetchBuilderSessionSnapshot } from './automationBuilderReads';

export function useBuilderSessionSnapshotRead<T>() {
    const qc = useQueryClient();
    return useCallback((automationId: string) => qc.fetchQuery<T | null>({
        queryKey: ['automation', automationId, 'builder-session'],
        queryFn: () => fetchBuilderSessionSnapshot<T>(automationId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    }), [qc]);
}
