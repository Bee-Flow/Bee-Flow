import { useCallback, useMemo, useState } from 'react';
import { useSupportThreadsQuery } from '../../api/queries/supportInbox';
import type { SupportThread } from './SupportInboxPanel.types';

const NO_THREADS: SupportThread[] = [];
const NO_COUNTS: Record<string, number> = {};

/** The status values a filter stands for in the list query; null means no status filter. */
function statusesFor(statusFilter: string): string[] | null {
    if (statusFilter === 'all') return null;
    // The follow-up queue cuts across status - a ticket awaiting the user
    // still owes them a word when the issue behind it moves - so it is a
    // separate filter rather than another status value.
    if (statusFilter === 'followup') return null;
    if (statusFilter === 'active') return ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent'];
    return [statusFilter];
}

/** The thread list: the counters, the status filter and the search text, and the read that follows them. */
export function useSupportThreadList() {
    const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'all' | one of statuses
    const [search, setSearch] = useState('');

    const queryString = useMemo(() => {
        const params = new URLSearchParams();
        const statuses = statusesFor(statusFilter);
        if (statuses) params.set('status', statuses.join(','));
        if (statusFilter === 'followup') params.set('followup', '1');
        if (search.trim()) params.set('q', search.trim());
        return params.toString();
    }, [statusFilter, search]);

    const query = useSupportThreadsQuery<SupportThread>(queryString);
    const { refetch } = query;
    const fetchThreads = useCallback(async () => { await refetch(); }, [refetch]);

    return {
        threads: query.data?.threads ?? NO_THREADS,
        counts: query.data?.counts ?? NO_COUNTS,
        statusFilter, setStatusFilter, search, setSearch,
        loading: query.isFetching, fetchThreads,
    };
}
