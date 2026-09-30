/** React Query keys for the run log. */

import type { RunFilters } from '../model/filters';
import type { RunScope } from '../model/types';

export const runLogKeys = {
    all: ['runLog'] as const,
    list: (scope: RunScope, filters: RunFilters) => ['runLog', 'list', scope, filters] as const,
    facets: (scope: RunScope, range: number, mode: string, automationId: string | null = null) =>
        ['runLog', 'facets', scope, range, mode, automationId] as const,
};
