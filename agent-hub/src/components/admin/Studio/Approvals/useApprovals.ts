import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRowLike } from './approvalDisplay';
import useAutomationApi from '../../../../hooks/useAutomationApi';

/**
 * List + facets state for the Approvals section, modeled on Executions'
 * useExecutions: cursor pagination with request-generation guards so a slow
 * page for a filter the user already left can never splice into the new list.
 *
 * `scope` is 'mine' | 'org'. The server decides whether the caller MAY use
 * 'org' (403 otherwise) — the hook only remembers what was asked for.
 */
interface UseApprovalsArgs {
    scope?: string;
    status?: string | null;
    q?: string | null;
}

/** One approval in the list (rowToApproval); the list reads these fields. */
export interface ApprovalListRow extends ApprovalRowLike {
    id: string;
    createdAt?: string | null;
    expiresAt?: string | null;
    decidedByName?: string | null;
    assigneeUserId?: string | null;
    assigneeGroupId?: string | null;
    ownerId?: string | null;
}

/** The status counts the tabs show. */
export interface ApprovalFacets {
    status: Record<string, number>;
}

/** GET /approvals. */
interface ApprovalsPage {
    approvals?: ApprovalListRow[];
    nextCursor?: string | null;
}

/** GET /approvals/facets. */
interface FacetsResponse {
    facets?: ApprovalFacets;
}

interface LoadArgs {
    append?: boolean;
    after?: string | null;
}

export default function useApprovals({ scope = 'mine', status = null, q = null }: UseApprovalsArgs = {}) {
    const api = useAutomationApi();
    const [rows, setRows] = useState<ApprovalListRow[]>([]);
    const [facets, setFacets] = useState<ApprovalFacets>({ status: {} });
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const gen = useRef(0);

    const load = useCallback(async ({ append = false, after = null }: LoadArgs = {}) => {
        const g = ++gen.current;
        setLoading(true);
        setError(null);
        try {
            const [list, fac] = (await Promise.all([
                api.listApprovals({ scope, status: status || undefined, q: q || undefined, cursor: after || undefined }),
                append ? null : api.approvalFacets(scope),
            ])) as [ApprovalsPage, FacetsResponse | null];
            if (g !== gen.current) return; // a newer request superseded this one
            setRows(prev => (append ? [...prev, ...(list.approvals || [])] : (list.approvals || [])));
            setCursor(list.nextCursor || null);
            if (fac) setFacets(fac.facets || { status: {} });
        } catch (e) {
            if (g !== gen.current) return;
            setError((e as Error).message || 'Could not load approvals');
            if (!append) setRows([]);
        } finally {
            if (g === gen.current) setLoading(false);
        }
    }, [api, scope, status, q]);

    useEffect(() => { load(); }, [load]);

    // Liveness without SSE: poll the (cheap) facets at the bell's cadence and
    // refetch the list only when the pending count actually moves. Prod is
    // multi-pod and the run event bus is single-process, so polling is the
    // honest mechanism, not the fallback.
    const pendingRef = useRef<number>(null);
    useEffect(() => {
        const timer = setInterval(async () => {
            try {
                const f = (await api.approvalFacets(scope)) as FacetsResponse;
                const pending = Number(f?.facets?.status?.pending) || 0;
                if (pendingRef.current !== null && pending !== pendingRef.current) load();
                pendingRef.current = pending;
                setFacets(f.facets || { status: {} });
            } catch { /* keep the last good data */ }
        }, 30_000);
        return () => clearInterval(timer);
    }, [api, scope, load]);

    const loadMore = useCallback(() => {
        if (cursor && !loading) load({ append: true, after: cursor });
    }, [cursor, loading, load]);

    /**
     * Optimistic single-row swap after a decision, plus a facet refresh. A row
     * whose new status no longer matches the active tab LEAVES the list — a
     * just-approved request lingering under "Waiting" reads as a bug.
     */
    const patchRow = useCallback((approval: ApprovalListRow) => {
        setRows(prev => prev
            .map(r => (r.id === approval.id ? approval : r))
            .filter(r => !status || r.status === status));
        api.approvalFacets(scope).then(f => setFacets((f as FacetsResponse).facets || { status: {} })).catch(() => {});
    }, [api, scope, status]);

    return { rows, facets, loading, error, hasMore: !!cursor, loadMore, reload: () => load(), patchRow };
}
