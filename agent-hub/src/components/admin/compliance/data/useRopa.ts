import { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';
import { API, fetchJson, json, jsonInit } from '@/api/complianceApi';
import useResource from './useResource';
import type { Id, UseRopaArgs } from './registers.types';

export const noop = () => {};

// ── ROPA ───────────────────────────────────────────────────────────────────
export function useRopa({ enabled = false, onChanged = noop, refreshCore = noop }: UseRopaArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/ropa`, {
        enabled,
        onError: (e: unknown) => { console.error('[ComplianceHub] ROPA fetch error:', (e as Error).message); return { error: true }; },
    });
    const [busy, setBusy] = useState(false);
    const review = async () => {
        setBusy(true);
        try {
            await fetchJson(`${API}/ropa/review`, { method: 'POST' });
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(t('compliance.ropa_toast_reviewed', 'Processing register marked as reviewed'));
        } catch (e) {
            toast.error(t('compliance.ropa_toast_review_failed', 'Could not mark the register as reviewed'));
        } finally { setBusy(false); }
    };
    const sccToggle = async (operator: string | null | undefined, confirmed: boolean) => {
        setBusy(true);
        try {
            await fetchJson(`${API}/settings/scc`, json({ operator, confirmed }));
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(confirmed
                ? t('compliance.scc_toast_confirmed', 'SCC attestation recorded')
                : t('compliance.scc_toast_revoked', 'SCC attestation withdrawn'));
        } catch (e) {
            toast.error(t('compliance.scc_toast_failed', 'Could not update the SCC attestation'));
        } finally { setBusy(false); }
    };
    // Collaborative projects with personal data and their processing records
    // (GET/PUT/DELETE /ropa/projects). A save or removal throws back to the
    // form that asked, which says it inline; the register rebuilds after it.
    const projects = useResource(`${API}/ropa/projects`, {
        enabled,
        onError: (e: unknown) => { console.error('[ComplianceHub] ROPA projects fetch error:', (e as Error).message); return { error: true }; },
    });
    const saveProject = async (projectId: Id, body: unknown) => {
        await fetchJson(`${API}/ropa/projects/${encodeURIComponent(projectId)}`, jsonInit('PUT', body));
        await Promise.all([projects.refresh(), res.refresh()]);
        onChanged();
    };
    const removeProject = async (projectId: string | number | boolean) => {
        await fetchJson(`${API}/ropa/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        await Promise.all([projects.refresh(), res.refresh()]);
        onChanged();
    };
    return {
        ropa: res.data, busy, refresh: res.refresh, review, sccToggle,
        projects: projects.data, refreshProjects: projects.refresh, saveProject, removeProject,
    };
}
