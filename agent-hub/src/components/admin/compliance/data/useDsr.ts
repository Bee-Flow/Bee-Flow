import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import { API_DSR, fetchJson, json, asArray } from '@/api/complianceApi';
import useResource from './useResource';
import type { DsrRequestRow } from './aggregates';
import type { Id, UseDsrArgs } from './registers.types';
import { noop } from './useRopa';

// ── DSR ────────────────────────────────────────────────────────────────────
export function useDsr({ enabled = false, onChanged = noop, refreshCore = noop }: UseDsrArgs = {}) {
    const { t } = useTranslation();
    const res = useResource<DsrRequestRow[]>(`${API_DSR}/requests`, {
        enabled,
        parse: (b) => (asArray(b) ?? ((b as { requests?: unknown[] } | null) && Array.isArray((b as { requests?: unknown[] }).requests) ? (b as { requests: unknown[] }).requests : [])) as DsrRequestRow[],
        onError: (e: unknown) => { console.error('[ComplianceHub] DSR fetch error:', (e as Error).message); return []; },
    });
    const [busyId, setBusyId] = useState<Id | null>(null);
    const fulfil = async (id: Id, body: unknown) => {
        setBusyId(id);
        try {
            await fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}/fulfil`, json(body));
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(t('compliance.dsr_toast_updated', 'Request updated'));
        } catch (e) {
            console.error('[ComplianceHub] DSR update error:', (e as Error).message);
            toast.error(t('compliance.dsr_toast_update_failed', 'Could not update the request'));
        } finally { setBusyId(null); }
    };
    const post = (id: string | number | boolean, action: string, body?: unknown) => fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}/${action}`, json(body));
    const capture = async (body: unknown) => {
        const r = await fetchJson(`${API_DSR}/requests/manual`, json(body));
        await res.refresh(); onChanged();
        toast.success(t('compliance.dsr_toast_captured', 'Request recorded — the one-month clock is running'));
        return r;
    };
    const start = async (id: string | number | boolean) => { await post(id, 'start'); await res.refresh(); onChanged(); };
    const extend = async (id: Id, reason: string) => {
        setBusyId(id);
        try { await post(id, 'extend', { reason }); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.dsr_toast_extend_failed', 'Could not extend the deadline')); throw e; }
        finally { setBusyId(null); }
    };
    const verifyIdentity = async (id: Id, body: unknown) => { await post(id, 'verify-identity', body); await res.refresh(); };
    const loadDetail = (id: string | number | boolean) => fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}`);
    // The route answers `{ id, timeline }`, not a bare array — asArray on the
    // envelope gives null, which reads as "could not load" for a request whose
    // timeline loaded fine.
    const loadTimeline = (id: string | number | boolean) => fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}/timeline`)
        .then(r => asArray(r && typeof r === 'object' && !Array.isArray(r) ? r.timeline : r));
    const loadDiscovery = (id: string | number | boolean) => fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}/discovery`);
    const exportUrlFor = (id: string | number | boolean) => `${API_DSR}/requests/${encodeURIComponent(id)}/export`;
    return {
        requests: res.data, busyId, failed: res.failed, refresh: res.refresh,
        fulfil, update: fulfil, capture, start, extend, verifyIdentity, loadDetail, loadTimeline, loadDiscovery, exportUrlFor,
    };
}
