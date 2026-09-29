import { useState, useEffect, useRef } from 'react';
import { readNavHas, writeNavHas } from './sidebarTokens';
import { API_BASE, authFetch } from '../../../utils/helpers';

/** Every status bucket added up — "does this person have approvals at all". */
const facetTotal = (facets) => Object.values(facets?.status || {})
    .reduce((n, v) => n + (Number(v) || 0), 0);

/**
 * State for the sidebar's Approvals row: how many decisions are waiting on this
 * person (the badge), and whether the row belongs in the menu at all.
 *
 * `pendingCount` is the personal queue, unchanged — the badge has always meant
 * "waiting on YOU" and must keep meaning exactly that.
 *
 * `hasApprovals` is the visibility answer, and it is deliberately NOT "is
 * something pending": the decided ones are a record people go looking for, so
 * the row stays as long as this person is part of ANY approval, in any status.
 * It only disappears for someone who has never been in one — for whom the row
 * has never led anywhere.
 *
 * The org-scope probe is the exception that keeps that honest. An org admin
 * browses the whole organisation's approvals, so their own empty inbox is not
 * an empty section, and taking the row away would hide the org's record from
 * the one person entitled to read it. Asked only when the personal scope came
 * back empty, so the ordinary case stays exactly one request per poll.
 *
 * Polled at the NotificationCenter's cadence and skipped while the tab is
 * hidden, with a visibilitychange catch-up — a badge nobody is looking at is
 * not worth a request, and the poll is not keyed on the route: including it
 * tore the interval down and rebuilt it (re-firing the load) on every single
 * in-app navigation.
 */
export function useApprovalsNav({ canBrowseApprovals, isOrgAdmin }) {
    const [pendingCount, setPendingCount] = useState(0);
    const [hasApprovals, setHasApprovals] = useState(() => readNavHas('approvals'));
    // Asked once, then remembered: an organisation that HAS approvals does not
    // stop having them, and without this an admin with a permanently empty
    // personal inbox — a very ordinary way to be an admin — would pay for the
    // org probe on every single poll, forever.
    const orgHasApprovalsRef = useRef(false);

    useEffect(() => {
        if (!canBrowseApprovals) { setPendingCount(0); return undefined; }
        let cancelled = false;
        const load = async () => {
            // Don't poll into a tab nobody is looking at. A signed-in user with
            // the app parked in a background tab all day is the common case,
            // and the badge is only meaningful while it is on screen; the
            // visibilitychange handler below refreshes it the moment they come
            // back, so nothing is stale by the time it is seen.
            if (document.visibilityState === 'hidden') return;
            try {
                const res = await authFetch(`${API_BASE}/api/automation/approvals/facets?scope=mine`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                setPendingCount(Number(data?.facets?.status?.pending) || 0);
                let any = facetTotal(data?.facets) > 0;
                if (!any && isOrgAdmin) {
                    if (orgHasApprovalsRef.current) {
                        any = true;
                    } else {
                        // 403 when the session's role no longer carries the org
                        // scope — then the personal answer is the whole answer.
                        const orgRes = await authFetch(`${API_BASE}/api/automation/approvals/facets?scope=org`);
                        if (cancelled) return;
                        if (orgRes.ok) any = facetTotal((await orgRes.json())?.facets) > 0;
                        orgHasApprovalsRef.current = any;
                    }
                }
                if (cancelled) return;
                setHasApprovals(any);
                writeNavHas('approvals', any);
            } catch { /* silent — the row keeps its last known shape */ }
        };
        load();
        const timer = setInterval(load, 30_000);
        // Catch up on return rather than waiting out the rest of the interval.
        const onVisible = () => { if (document.visibilityState === 'visible') load(); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            cancelled = true;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [canBrowseApprovals, isOrgAdmin]);

    return { pendingCount, hasApprovals };
}

export default useApprovalsNav;
