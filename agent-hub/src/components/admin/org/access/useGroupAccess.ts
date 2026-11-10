// The data and the saving of the Grants matrix: what the org's ceiling holds,
// what All members and each group have, and a debounced save per scope. A save
// that fails reloads the matrix, so the screen never shows a grant the server
// does not hold.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import { messageOf } from '@/utils/caughtError';
import { mutate, ApiError, request, RefusedError } from '@/api/mutate';
import type { AccessCapability, AccessData, AccessMessage } from './accessTypes';

const SAVE_DEBOUNCE_MS = 450;

/** The scope id of "All members"; every other scope is a group id. */
export const EVERYONE = '__everyone__';

export function useGroupAccess(orgIdProp: string | null) {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [data, setData] = useState<AccessData | null>(null);
    const [message, setMessage] = useState<AccessMessage | null>(null);

    const [everyone, setEveryone] = useState<Set<string>>(() => new Set());
    const [groupGrants, setGroupGrants] = useState<Record<string, Set<string>>>({});

    // One pending save per scope (EVERYONE or a group id).
    const timers = useRef<Record<string, ReturnType<typeof setTimeout> | undefined>>({});

    const readPath = orgIdProp
        ? `${API_BASE}/auth/organizations/${encodeURIComponent(orgIdProp)}/group-access`
        : `${API_BASE}/auth/me/group-access`;
    const orgWritePath = orgIdProp
        ? `${API_BASE}/auth/organizations/${encodeURIComponent(orgIdProp)}/org-access`
        : `${API_BASE}/auth/me/org-access`;

    const load = useCallback(async () => {
        setLoading(true);
        try {
            let res: Response;
            try {
                res = await request(readPath);
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                setMessage({ type: 'error', text: t('admin_org.access_matrix_failed_load_status', 'Failed to load ({status})', { status: err.status }) });
                setLoading(false);
                return;
            }
            const j = await res.json();
            setData(j);
            setEveryone(new Set(j.everyone || []));
            const gg: Record<string, Set<string>> = {};
            for (const g of (j.groups || [])) gg[g.id] = new Set(g.granted || []);
            setGroupGrants(gg);
        } catch (e) {
            setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_failed_load', 'Failed to load')) });
        } finally { setLoading(false); }
    }, [readPath, t]);

    useEffect(() => { load(); }, [load]);
    useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), 3500); return () => clearTimeout(timer); }, [message]);
    useEffect(() => () => { Object.values(timers.current).forEach(timer => timer && clearTimeout(timer)); }, []);

    const ceiling = useMemo(() => new Set(data?.ceiling || []), [data]);
    const groups = useMemo(() => data?.groups || [], [data?.groups]);

    // Debounced PUT of one scope's grants: All members to the org, a group to that group.
    const save = (scope: string, nextSet: Set<string>) => {
        const url = scope === EVERYONE ? orgWritePath : `${API_BASE}/auth/groups/${encodeURIComponent(scope)}/access`;
        if (timers.current[scope]) clearTimeout(timers.current[scope]);
        timers.current[scope] = setTimeout(async () => {
            try {
                try {
                    await mutate(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ granted: [...nextSet] }) });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error(t('admin_org.access_matrix_save_failed', 'Save failed'));
                }
                setMessage({ type: 'ok', text: t('admin_org.access_matrix_saved', 'Saved') });
            } catch (e) { setMessage({ type: 'error', text: messageOf(e, t('admin_org.access_matrix_save_failed', 'Save failed')) }); load(); }
        }, SAVE_DEBOUNCE_MS);
    };

    // On cloud the subscription decides which betas reach all members, so the
    // beta rows are read-only there. A group-scoped beta (e.g. Meeting Notes)
    // is the exception in both modes: "All members" is a real choice for it,
    // and a group can hold it while All members does not.
    const betaReadOnly = (cap: AccessCapability) => cap.kind === 'beta' && data?.betaGoverned && !cap.groupScoped;

    const toggle = (scope: string, cap: AccessCapability) => {
        if (!ceiling.has(cap.id) || betaReadOnly(cap)) return;
        if (scope === EVERYONE) {
            setEveryone(prev => { const n = new Set(prev); n.has(cap.id) ? n.delete(cap.id) : n.add(cap.id); save(EVERYONE, n); return n; });
        } else {
            setGroupGrants(prev => {
                const cur = new Set(prev[scope] || []);
                cur.has(cap.id) ? cur.delete(cap.id) : cur.add(cap.id);
                const next = { ...prev, [scope]: cur };
                save(scope, cur);
                return next;
            });
        }
    };

    return { loading, data, message, everyone, groupGrants, ceiling, groups, betaReadOnly, toggle };
}
