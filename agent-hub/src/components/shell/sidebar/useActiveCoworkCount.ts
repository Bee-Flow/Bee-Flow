import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * How much is currently running or scheduled, shown as a badge on the Cowork
 * row. Counted from /api/cowork, not /api/ai-tasks: prompt tasks were
 * migrated into cowork, and the old count was fetched every render pass but
 * never actually displayed anywhere.
 *
 * Re-read whenever the user leaves or enters Cowork (`currentPage` changes),
 * so create / pause / delete over there is reflected when they come back.
 * Split out of Sidebar.jsx without a change in behaviour.
 */
export function useActiveCoworkCount(currentPage: string | undefined): number {
    const [activeCoworkCount, setActiveCoworkCount] = useState(0);
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/cowork`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                const schedules: Array<{ isActive?: boolean }> = Array.isArray(data?.schedules) ? data.schedules : [];
                setActiveCoworkCount(schedules.filter(s => s.isActive).length);
            } catch { /* silent */ }
        };
        load();
        return () => { cancelled = true; };
    }, [currentPage]);
    return activeCoworkCount;
}
