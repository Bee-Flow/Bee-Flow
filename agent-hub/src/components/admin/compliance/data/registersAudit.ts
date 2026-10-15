/**
 * The audit, access-trail and org-directory register hooks, split out of
 * registers.ts (which stays under the file budget). They take the same
 * { enabled, onChanged } options and return the same names; registers.ts
 * re-exports them, so every importer is unchanged.
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { API, fetchJson, json, jsonInit, asArray } from './api';
import useResource from './useResource';
import type { AccessActionRow, AuditPayload, OrgUser, RegisterOptions, Rec } from './registerTypes';

const noop = () => {};

// ── Audits & management review ─────────────────────────────────────────────
export function useAudit({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<AuditPayload>(`${API}/iso/audit`, {
        enabled,
        onError: (e) => ({ audits: [], findings: [], reviews: [], ncs: [], objectives: [], mr_inputs: null, error: (e as Error).message }),
    });
    const [busy, setBusy] = useState(false);
    const [independenceWarning, setIndependenceWarning] = useState<string | null>(null);
    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try { await fn(); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.audit_toast_failed', 'Could not save — try again')); }
        finally { setBusy(false); }
    };
    const createAudit = async (fields: Rec & { auditor_user_id?: string | number | null }) => {
        // Independence probe (9.2.2): record the conflict before the audit exists.
        if (fields?.auditor_user_id) {
            try {
                const ind = await fetchJson<{ independent?: boolean; conflicts?: string[] }>(`${API}/iso/audit/independence/${encodeURIComponent(String(fields.auditor_user_id))}`);
                setIndependenceWarning(ind?.independent === false
                    ? t('compliance.audit_independence_warning',
                        'Independence conflict: this auditor {conflicts}',
                        { conflicts: (ind.conflicts || []).join('; ') })
                    : null);
            } catch { setIndependenceWarning(null); }
        }
        return run(() => fetchJson(`${API}/iso/audits`, json(fields)));
    };
    const updateAudit = (id: number | string, patch: unknown) => run(() => fetchJson(`${API}/iso/audits/${id}`, jsonInit('PUT', patch)));
    const addFinding = (auditId: number | string, fields: unknown) => run(() => fetchJson(`${API}/iso/audits/${auditId}/findings`, json(fields)));
    const createReview = (fields: Rec) => run(() => fetchJson(`${API}/iso/reviews`, json({ ...fields, inputs: res.data?.mr_inputs || {} })));
    const createNc = (fields: unknown) => run(() => fetchJson(`${API}/iso/ncs`, json(fields)));
    const updateNc = (id: number | string, patch: unknown) => run(() => fetchJson(`${API}/iso/ncs/${id}`, jsonInit('PUT', patch)));
    const createObjective = (fields: unknown) => run(() => fetchJson(`${API}/iso/objectives`, json(fields)));
    const updateObjective = (id: number | string, patch: unknown) => run(() => fetchJson(`${API}/iso/objectives/${id}`, jsonInit('PUT', patch)));
    return {
        audits: res.data?.audits ?? (res.data ? [] : null), findings: res.data?.findings || [], reviews: res.data?.reviews || [],
        ncs: res.data?.ncs || [], objectives: res.data?.objectives || [], mrInputs: res.data?.mr_inputs || null,
        busy, independenceWarning, refresh: res.refresh,
        createAudit, updateAudit, addFinding, createReview, createNc, updateNc, createObjective, updateObjective,
    };
}

// ── Access & authentication trail (A.8.15) ─────────────────────────────────
// Filtering and paging go to the SERVER. A client-side filter over one page
// would answer a different question than the operator typed: "every refused
// sign-in this month" would silently mean "…on this page".
export function useAccessAudit({ enabled = false }: { enabled?: boolean } = {}) {
    const [data, setData] = useState<Rec | null>(null);
    const [actions, setActions] = useState<AccessActionRow[]>([]);
    const [filter, setFilter] = useState<Rec>({});
    const [offset, setOffset] = useState(0);
    const [exportError, setExportError] = useState<string | null>(null);

    // The query string both the view and the export are built from, so the
    // file somebody downloads is exactly what they are looking at.
    const query = useMemo(() => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(filter)) {
            if (v !== undefined && v !== null && String(v) !== '') q.set(k, String(v));
        }
        return q;
    }, [filter]);

    useEffect(() => {
        if (!enabled) return undefined;
        let cancelled = false;
        const q = new URLSearchParams(query);
        q.set('offset', String(offset));
        setExportError(null);
        fetchJson<Rec>(`${API}/access-audit?${q.toString()}`)
            .then((d) => { if (!cancelled) setData(d); })
            .catch((e) => { if (!cancelled) setData({ error: (e as Error).message }); });
        fetchJson<{ actions?: AccessActionRow[] }>(`${API}/access-audit/actions?${query.toString()}`)
            .then((d) => { if (!cancelled) setActions(d?.actions || []); })
            // The filter control is a convenience; losing it must not blank the log.
            .catch(() => { if (!cancelled) setActions([]); });
        return () => { cancelled = true; };
    }, [enabled, query, offset]);

    return {
        data, actions, filter, offset, exportError,
        setFilter: (f: Rec) => { setFilter(f); setOffset(0); }, setOffset,
        exportUrl: `${API}/access-audit/export?${query.toString()}`,
    };
}

// ── Org member directory (pickers) ─────────────────────────────────────────
// Fetched only for the sections that show a picker — the nav test pins that
// the GDPR page never asks for the directory. null = not loaded; [] = failed
// or empty (pickers hide, free text stays available).
export function useOrgUsers({ enabled = false }: { enabled?: boolean } = {}) {
    const res = useResource<OrgUser[]>(`${API}/org-users`, { enabled, parse: (b) => asArray<OrgUser>(b) ?? [], onError: () => [] });
    return { orgUsers: res.data, refresh: res.refresh };
}
