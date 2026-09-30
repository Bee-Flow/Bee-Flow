/** Template queries. Screens call these rather than useQuery. */

import { useQuery } from '@tanstack/react-query';

import { listTemplates } from '../api/endpoints';
import { templateKeys } from '../api/keys';

/**
 * Never retried: the router is behind a beta flag, and a 403 is an answer,
 * not a transient fault — retrying it three times helps nobody.
 */
export function useTemplates() {
    return useQuery({
        queryKey: templateKeys.all,
        queryFn: ({ signal }) => listTemplates(signal),
        retry: false,
    });
}
