// The organisation's published automation forms (GET /api/automation/forms),
// as the Studio sidebar lists them: read when the forms page opens or the
// person comes back from Studio. A refusal reads as null: the row still opens
// the directory.

import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { RefusedError } from '../mutate';
import { apiRequest } from '../typedRequest';

export function usePublishedFormsRead<F>() {
    const qc = useQueryClient();
    return useCallback(() => qc.fetchQuery<F[] | null>({
        queryKey: ['automation', 'forms', 'published'],
        queryFn: async () => {
            let res: Response;
            try {
                res = await apiRequest('GET /api/automation/forms');
            } catch (err) {
                if (err instanceof RefusedError) return null;
                throw err;
            }
            const data = await res.json();
            return Array.isArray(data?.forms) ? data.forms as F[] : [];
        },
        staleTime: 0,
        retry: false,
    }), [qc]);
}
