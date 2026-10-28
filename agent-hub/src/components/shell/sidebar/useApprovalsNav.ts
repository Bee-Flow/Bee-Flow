import { useEffect } from 'react';
import { useApprovalsNavQuery } from '@/api/queries/shellReads';
import { readNavHas, writeNavHas } from './sidebarTokens';

/**
 * State for the sidebar's Approvals row: how many decisions are waiting on this
 * person (the badge), and whether the row belongs in the menu at all.
 *
 * `pendingCount` is the personal queue, unchanged - the badge has always meant
 * "waiting on YOU" and must keep meaning exactly that.
 *
 * `hasApprovals` is the visibility answer, and it is deliberately NOT "is
 * something pending": the decided ones are a record people go looking for, so
 * the row stays as long as this person is part of ANY approval, in any status.
 * It only disappears for someone who has never been in one - for whom the row
 * has never led anywhere. Until the first answer it is the last remembered
 * answer (sidebarTokens), so the menu does not jump on every page load.
 *
 * The org-scope probe is the exception that keeps that honest (see
 * useApprovalsNavQuery). The read is polled at the NotificationCenter's cadence
 * and skipped while the tab is hidden - a badge nobody is looking at is not
 * worth a request - and it is not keyed on the route: including it tore the
 * poll down and rebuilt it on every single in-app navigation.
 */
export function useApprovalsNav({ canBrowseApprovals, isOrgAdmin }: { canBrowseApprovals?: boolean; isOrgAdmin?: boolean }) {
    const query = useApprovalsNavQuery(!!canBrowseApprovals, !!isOrgAdmin);
    const answer = canBrowseApprovals ? query.data : undefined;

    const answered = answer?.hasApprovals;
    useEffect(() => {
        if (answered !== undefined) writeNavHas('approvals', answered);
    }, [answered]);

    return { pendingCount: answer?.pendingCount ?? 0, hasApprovals: answered ?? readNavHas('approvals') };
}
