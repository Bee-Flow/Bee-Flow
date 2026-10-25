import { useEffect, useRef } from 'react';
import { useActiveCoworkCountQuery } from '../../../api/queries/shellSidebar';

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
    const { data, refetch } = useActiveCoworkCountQuery();
    const lastPage = useRef(currentPage);
    useEffect(() => {
        if (lastPage.current === currentPage) return;
        lastPage.current = currentPage;
        void refetch();
    }, [currentPage, refetch]);
    return data ?? 0;
}
