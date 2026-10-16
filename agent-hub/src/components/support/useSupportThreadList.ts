import { useCallback, useEffect, useMemo, useState } from 'react';
import { supportInboxApi } from '../../api/supportInboxApi';
import { errorMessage } from '../../utils/caughtError';
import type { SupportThread } from './SupportInboxPanel.types';

/** The thread list: the counters, the status filter and the search text, and the fetch that follows them. */
export function useSupportThreadList() {
    const [threads, setThreads] = useState<SupportThread[]>([]);
    const [counts, setCounts] = useState<Record<string, number>>({});
    const [statusFilter, setStatusFilter] = useState('active'); // 'active' | 'all' | one of statuses
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);

    const statusInQuery = useMemo(() => {
        if (statusFilter === 'all') return null;
        // The follow-up queue cuts across status — a ticket awaiting the user
        // still owes them a word when the issue behind it moves — so it is a
        // separate filter rather than another status value.
        if (statusFilter === 'followup') return null;
        if (statusFilter === 'active') return ['open', 'ai_responding', 'awaiting_user', 'awaiting_agent'];
        return [statusFilter];
    }, [statusFilter]);

    const fetchThreads = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            if (statusInQuery) params.set('status', statusInQuery.join(','));
            if (statusFilter === 'followup') params.set('followup', '1');
            if (search.trim()) params.set('q', search.trim());
            const res = await supportInboxApi.threads(params.toString());
            if (res.ok) {
                const data = await res.json();
                setThreads(data.threads || []);
                setCounts(data.counts || {});
            }
        } catch (e) {
            console.warn('[Support] fetchThreads:', errorMessage(e));
        } finally {
            setLoading(false);
        }
    }, [statusInQuery, statusFilter, search]);

    useEffect(() => { fetchThreads(); }, [fetchThreads]);

    return { threads, counts, statusFilter, setStatusFilter, search, setSearch, loading, fetchThreads };
}
