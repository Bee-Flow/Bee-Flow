/**
 * The register hooks — one per rail row under REGISTERS and BEHEER, lifted
 * from the pre-redesign index.jsx with their mutation bodies and toast
 * sentences unchanged (index.test.jsx pins one English per key).
 *
 * Every hook takes `{ enabled, onChanged }`: `enabled` is "this section is
 * open" (data loads lazily, exactly as before), `onChanged` is the hub's
 * counts bump. Each returns the same names its page used as props, so
 * data/pages.js can hand a legacy page its old props and a redesigned page the
 * hook object itself.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import { toast } from '../../../shared/Toast';
import { API, API_DSR, fetchJson, json, jsonInit, asArray } from './api';
import useResource from './useResource';
import type {
    BusyKey, ConnectorRow, DpiaRow, DsrRequest, Envelope, IncidentRow, PolicyDoc, Rec, RegisterOptions,
    RiskRow, TrainingPayload, TreatmentRow,
} from './registerTypes';

// The types live in registerTypes.ts and the audit hooks in registersAudit.ts;
// re-exported here so every importer keeps its path.
export * from './registerTypes';
export { useAudit, useAccessAudit, useOrgUsers } from './registersAudit';

const noop = () => {};

/**
 * Shared busy/mutate wrapper: set busy → run → refresh → toast on failure.
 * Keeps its historic name `_isoMutate`: the i18n guard registers it as a
 * helper that takes a key as an ARGUMENT (KEY_ARG_HELPERS), so every
 * `errKey` below is checked against the dictionary like a t() call.
 */
function useIsoMutate(refresh: () => Promise<unknown>, onChanged?: () => void) {
    return useCallback(async (
        setBusy: (key: BusyKey) => void,
        busyKey: BusyKey,
        fn: () => Promise<unknown>,
        errKey: string,
        errFallback: string,
        t: TranslateFn,
    ): Promise<void> => {
        setBusy(busyKey);
        try { await fn(); await refresh(); onChanged?.(); }
        catch (e) { toast.error(t(errKey, errFallback)); }
        finally { setBusy(null); }
    }, [refresh, onChanged]);
}

// ── DSR ────────────────────────────────────────────────────────────────────
export function useDsr({ enabled = false, onChanged = noop, refreshCore = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<DsrRequest[]>(`${API_DSR}/requests`, {
        enabled,
        parse: (b) => asArray<DsrRequest>(b) ?? (b && Array.isArray((b as Envelope<DsrRequest>).requests) ? (b as Envelope<DsrRequest>).requests as DsrRequest[] : []),
        onError: (e) => { console.error('[ComplianceHub] DSR fetch error:', (e as Error).message); return []; },
    });
    const [busyId, setBusyId] = useState<BusyKey>(null);

    const fulfil = async (id: number | string, body: unknown) => {
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
    const post = (id: number | string, action: string, body?: unknown) => fetchJson(`${API_DSR}/requests/${encodeURIComponent(id)}/${action}`, json(body));
    const capture = async (body: unknown) => {
        const r = await fetchJson(`${API_DSR}/requests/manual`, json(body));
        await res.refresh(); onChanged();
        toast.success(t('compliance.dsr_toast_captured', 'Request recorded — the one-month clock is running'));
        return r;
    };
    const start = async (id: number | string) => { await post(id, 'start'); await res.refresh(); onChanged(); };
    const extend = async (id: number | string, reason: string) => {
        setBusyId(id);
        try { await post(id, 'extend', { reason }); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.dsr_toast_extend_failed', 'Could not extend the deadline')); throw e; }
        finally { setBusyId(null); }
    };
    const verifyIdentity = async (id: number | string, body: unknown) => { await post(id, 'verify-identity', body); await res.refresh(); };
    const loadDetail = (id: number | string) => fetchJson<Rec>(`${API_DSR}/requests/${encodeURIComponent(id)}`);
    // The route answers `{ id, timeline }`, not a bare array — asArray on the
    // envelope gives null, which reads as "could not load" for a request whose
    // timeline loaded fine.
    const loadTimeline = (id: number | string) => fetchJson<unknown>(`${API_DSR}/requests/${encodeURIComponent(id)}/timeline`)
        .then(r => asArray(r && typeof r === 'object' && !Array.isArray(r) ? (r as Rec).timeline : r));
    const loadDiscovery = (id: number | string) => fetchJson<Rec>(`${API_DSR}/requests/${encodeURIComponent(id)}/discovery`);
    const exportUrlFor = (id: number | string) => `${API_DSR}/requests/${encodeURIComponent(id)}/export`;

    return {
        requests: res.data, busyId, failed: res.failed, refresh: res.refresh,
        fulfil, update: fulfil, capture, start, extend, verifyIdentity, loadDetail, loadTimeline, loadDiscovery, exportUrlFor,
    };
}

// ── ROPA ───────────────────────────────────────────────────────────────────
export function useRopa({ enabled = false, onChanged = noop, refreshCore = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<Rec>(`${API}/ropa`, {
        enabled,
        onError: (e) => { console.error('[ComplianceHub] ROPA fetch error:', (e as Error).message); return { error: true }; },
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
    const sccToggle = async (operator: string, confirmed: boolean) => {
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
    const projects = useResource<unknown>(`${API}/ropa/projects`, {
        enabled,
        onError: (e) => { console.error('[ComplianceHub] ROPA projects fetch error:', (e as Error).message); return { error: true }; },
    });
    const saveProject = async (projectId: string, body: unknown) => {
        await fetchJson(`${API}/ropa/projects/${encodeURIComponent(projectId)}`, jsonInit('PUT', body));
        await Promise.all([projects.refresh(), res.refresh()]);
        onChanged();
    };
    const removeProject = async (projectId: string) => {
        await fetchJson(`${API}/ropa/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' });
        await Promise.all([projects.refresh(), res.refresh()]);
        onChanged();
    };
    return {
        ropa: res.data, busy, refresh: res.refresh, review, sccToggle,
        projects: projects.data, refreshProjects: projects.refresh, saveProject, removeProject,
    };
}

// ── DPIA ───────────────────────────────────────────────────────────────────
export function useDpia({ enabled = false, onChanged = noop, refreshCore = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<DpiaRow[]>(`${API}/dpia`, {
        enabled, parse: (b) => asArray<DpiaRow>(b) ?? [],
        onError: (e) => { console.error('[ComplianceHub] DPIA fetch error:', (e as Error).message); return []; },
    });
    const [savingId, setSavingId] = useState<BusyKey>(null);
    const save = async (agentId: string, body: unknown) => {
        setSavingId(agentId);
        try {
            await fetchJson(`${API}/dpia/${encodeURIComponent(agentId)}`, json(body));
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(t('compliance.dpia_toast_saved', 'DPIA recorded'));
        } catch (e) {
            toast.error(t('compliance.dpia_toast_failed', 'Could not save the DPIA'));
        } finally { setSavingId(null); }
    };
    const pdfUrlFor = (agentId: string) => `${API}/dpia/${encodeURIComponent(agentId)}/pdf`;
    return { dpiaList: res.data, savingId, refresh: res.refresh, save, pdfUrlFor };
}

// ── Incidents (Art. 33/34 + CRA vulnerability register) ────────────────────
export function useIncidents({ enabled = false, onChanged = noop, refreshCore = noop, kind = null }: RegisterOptions & { kind?: string | null } = {}) {
    const { t } = useTranslation();
    const url = kind ? `${API}/incidents?kind=${encodeURIComponent(kind)}` : `${API}/incidents`;
    const res = useResource<IncidentRow[]>(url, {
        enabled, parse: (b) => asArray<IncidentRow>(b) ?? (b && Array.isArray((b as Envelope<IncidentRow>).incidents) ? (b as Envelope<IncidentRow>).incidents as IncidentRow[] : []),
        onError: (e) => { console.error('[ComplianceHub] incidents fetch error:', (e as Error).message); return []; },
    });
    const [busyId, setBusyId] = useState<BusyKey>(null);
    const create = async (body: unknown) => {
        try {
            await fetchJson(`${API}/incidents`, json(body));
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(t('compliance.inc_toast_created', 'Incident recorded — the 72-hour clock is running'));
        } catch (e) {
            toast.error(t('compliance.inc_toast_failed', 'Could not save the incident'));
        }
    };
    const update = async (id: number | string, body: unknown) => {
        setBusyId(id);
        try {
            await fetchJson(`${API}/incidents/${encodeURIComponent(id)}`, jsonInit('PATCH', body));
            await Promise.all([res.refresh(), refreshCore()]);
            onChanged();
            toast.success(t('compliance.inc_toast_updated', 'Incident updated'));
        } catch (e) {
            toast.error(t('compliance.inc_toast_failed', 'Could not save the incident'));
        } finally { setBusyId(null); }
    };
    const notify = async (id: number | string) => {
        setBusyId(id);
        try {
            const r = await fetchJson<{ notified?: number }>(`${API}/incidents/${encodeURIComponent(id)}/notify-recipients`, { method: 'POST' });
            await res.refresh();
            toast.success(t('compliance.inc_toast_notified', { count: r?.notified ?? '' }) ||
                `Breach recipients notified (${r?.notified ?? 0})`);
        } catch (e) {
            toast.error(t('compliance.inc_toast_notify_failed', 'Could not send the notification — check breach recipients and SMTP'));
        } finally { setBusyId(null); }
    };
    const craReport = async (id: number | string, body: unknown) => {
        setBusyId(id);
        try { await fetchJson(`${API}/incidents/${encodeURIComponent(id)}/cra-report`, json(body)); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.vuln_toast_report_failed', 'Could not record the report')); }
        finally { setBusyId(null); }
    };
    const customerNotified = async (id: number | string) => {
        setBusyId(id);
        try { await fetchJson(`${API}/incidents/${encodeURIComponent(id)}/customer-notified`, json({})); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.inc_toast_failed', 'Could not save the incident')); }
        finally { setBusyId(null); }
    };
    return { incidents: res.data, busyId, refresh: res.refresh, create, update, notify, craReport, customerNotified };
}

// ── ISO SoA ────────────────────────────────────────────────────────────────
export function useSoa({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<Rec>(`${API}/iso/soa`, { enabled, onError: (e) => ({ error: (e as Error).message }) });
    const [busyRef, setBusyRef] = useState<BusyKey>(null);
    const seed = async () => {
        setBusyRef('seed');
        try {
            const r = await fetchJson<{ inserted?: number }>(`${API}/iso/soa/seed`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.soa_toast_seeded', { count: r?.inserted ?? 0 }) || `Seeded ${r?.inserted ?? 0} SoA rows`);
        } catch (e) {
            toast.error(t('compliance.soa_toast_seed_failed', 'Could not seed the SoA'));
        } finally { setBusyRef(null); }
    };
    const update = async (ref: string, patch: unknown) => {
        setBusyRef(ref);
        try {
            await fetchJson(`${API}/iso/soa/${encodeURIComponent(ref)}`, jsonInit('PUT', patch));
            await res.refresh(); onChanged();
        } catch (e) {
            toast.error(t('compliance.soa_toast_save_failed', 'Could not save the SoA row'));
        } finally { setBusyRef(null); }
    };
    const loadHistory = () => fetchJson<unknown>(`${API}/iso/soa/history`).then(asArray);
    return { soa: res.data, busyRef, refresh: res.refresh, seed, update, loadHistory };
}

// ── ISMS policy documents ──────────────────────────────────────────────────
export function usePolicies({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<{ documents: PolicyDoc[]; missing_seeds: unknown[]; error?: string; [key: string]: unknown }>(`${API}/iso/docs`, {
        enabled,
        onError: (e) => ({ error: (e as Error).message, documents: [], missing_seeds: [] }),
    });
    const [busySlug, setBusySlug] = useState<string | null>(null);
    const seed = async () => {
        setBusySlug('seed');
        try {
            const r = await fetchJson<{ inserted?: number }>(`${API}/iso/docs/seed`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.policies_toast_seeded', { count: r?.inserted ?? 0 }) || `Seeded ${r?.inserted ?? 0} policy templates`);
        } catch (e) {
            toast.error(t('compliance.policies_toast_seed_failed', 'Could not seed policy templates'));
        } finally { setBusySlug(null); }
    };
    const loadDoc = async (slug: string) => {
        try { return await fetchJson<PolicyDoc>(`${API}/iso/docs/${encodeURIComponent(slug)}`); }
        catch { return null; }
    };
    const save = async (slug: string, patch: unknown) => {
        setBusySlug(slug);
        try {
            await fetchJson(`${API}/iso/docs/${encodeURIComponent(slug)}`, jsonInit('PUT', patch));
            await res.refresh();
        } catch (e) {
            toast.error(t('compliance.policies_toast_save_failed', 'Could not save the document'));
        } finally { setBusySlug(null); }
    };
    const publish = async (slug: string) => {
        setBusySlug(slug);
        try {
            const doc = await fetchJson<{ current_version?: number | string }>(`${API}/iso/docs/${encodeURIComponent(slug)}/publish`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.policies_toast_published', { version: doc?.current_version ?? '' }) || `Published v${doc?.current_version}`);
        } catch (e) {
            toast.error(t('compliance.policies_toast_publish_failed', 'Could not publish the document'));
        } finally { setBusySlug(null); }
    };
    return { docs: res.data, busySlug, refresh: res.refresh, seed, loadDoc, save, publish };
}

// ── Evidence connectors ────────────────────────────────────────────────────
export function useConnectors({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<ConnectorRow[]>(`${API}/iso/connectors`, { enabled, parse: (b) => asArray<ConnectorRow>(b) ?? [], onError: () => [] });
    const [busyId, setBusyId] = useState<BusyKey>(null);
    const save = async (id: number | string, patch: unknown) => {
        setBusyId(id);
        try {
            await fetchJson(`${API}/iso/connectors/${encodeURIComponent(id)}`, jsonInit('PUT', patch));
            await res.refresh(); onChanged();
            toast.success(t('compliance.conn_toast_saved', 'Connector saved'));
        } catch (e) {
            toast.error(t('compliance.conn_toast_save_failed', 'Could not save the connector'));
        } finally { setBusyId(null); }
    };
    const sweep = async (id: number | string) => {
        setBusyId(id);
        try {
            const r = await fetchJson<{ subjects?: number; changed?: number }>(`${API}/iso/connectors/${encodeURIComponent(id)}/sweep`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.conn_toast_swept', { subjects: r?.subjects ?? 0, changed: r?.changed ?? 0 }) || `Sweep done — ${r?.subjects ?? 0} subject(s), ${r?.changed ?? 0} changed`);
        } catch (e) {
            await res.refresh();
            toast.error(t('compliance.conn_toast_sweep_failed', 'Sweep failed — check the credential and settings'));
        } finally { setBusyId(null); }
    };
    const loadConnections = async (id: number | string) => {
        try { return await fetchJson<unknown[]>(`${API}/iso/connectors/${encodeURIComponent(id)}/connections`); }
        catch { return []; }
    };
    return { connectors: res.data, busyId, refresh: res.refresh, save, sweep, loadConnections };
}

// ── Risk register ──────────────────────────────────────────────────────────
export function useRisks({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<{ risks?: RiskRow[]; treatments?: TreatmentRow[]; stats?: Rec | null; error?: string }>(`${API}/iso/risks`, {
        enabled,
        onError: (e) => ({ risks: [], treatments: [], stats: null, error: (e as Error).message }),
    });
    const [busyId, setBusyId] = useState<BusyKey>(null);
    const _isoMutate = useIsoMutate(res.refresh, onChanged);
    const create = (fields: unknown) => _isoMutate(setBusyId, 'create',
        () => fetchJson(`${API}/iso/risks`, json(fields)),
        'compliance.risk_toast_failed', 'Could not save the risk', t);
    const update = (id: number | string, patch: unknown) => _isoMutate(setBusyId, id,
        () => fetchJson(`${API}/iso/risks/${id}`, jsonInit('PUT', patch)),
        'compliance.risk_toast_failed', 'Could not save the risk', t);
    const addTreatment = (riskId: number | string, fields: unknown) => _isoMutate(setBusyId, riskId,
        () => fetchJson(`${API}/iso/risks/${riskId}/treatments`, json(fields)),
        'compliance.risk_treatment_toast_failed', 'Could not save the treatment', t);
    const seed = () => _isoMutate(setBusyId, 'seed',
        async () => {
            const r = await fetchJson<{ inserted?: number }>(`${API}/iso/risks/seed`, json({}));
            toast.success(t('compliance.risk_toast_seeded', 'Seeded {count} risk scenario(s)', { count: r?.inserted ?? 0 }));
        },
        'compliance.risk_seed_toast_failed', 'Could not seed risks', t);
    return {
        risks: res.data?.risks ?? (res.data ? [] : null), treatments: res.data?.treatments || [], stats: res.data?.stats || null,
        busyId, refresh: res.refresh, create, update, addTreatment, seed,
    };
}

// ── Training & competence ──────────────────────────────────────────────────
export function useTraining({ enabled = false, onChanged = noop }: RegisterOptions = {}) {
    const { t } = useTranslation();
    const res = useResource<TrainingPayload>(`${API}/iso/training`, { enabled, onError: (e) => ({ personnel: [], obligations: [], error: (e as Error).message }) });
    const [busyId, setBusyId] = useState<BusyKey>(null);
    const _isoMutate = useIsoMutate(res.refresh, onChanged);
    const attest = (userId: string, note: string) => _isoMutate(setBusyId, userId,
        () => fetchJson(`${API}/iso/training/${encodeURIComponent(userId)}/attest`, json({ note })),
        'compliance.training_toast_failed', 'Could not record the attestation', t);
    const createObligation = (fields: unknown) => _isoMutate(setBusyId, 'create',
        () => fetchJson(`${API}/iso/obligations`, json(fields)),
        'compliance.obl_toast_failed', 'Could not save the obligation', t);
    const completeObligation = (id: number | string) => _isoMutate(setBusyId, id,
        () => fetchJson(`${API}/iso/obligations/${id}/complete`, json({})),
        'compliance.obl_complete_toast_failed', 'Could not complete the obligation', t);
    return {
        personnel: res.data?.personnel ?? (res.data ? [] : null), obligations: res.data?.obligations ?? (res.data ? [] : null),
        busyId, refresh: res.refresh, attest, createObligation, completeObligation,
    };
}

