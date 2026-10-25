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
import { API, fetchJson, json, jsonInit, asArray } from '../../../../api/complianceApi';
import useResource from './useResource';
import type { SoaControl } from '../pages/soa/SoaTable';
import type { AccessAuditRow } from '../pages/accessAuditLabels';
import type { DpiaRecord } from '../pages/dpia/DpiaDrawer';
import type { Id, UseDpiaArgs, UseIncidentsArgs, UseSoaArgs, SoaBody, UsePoliciesArgs, UseConnectorsArgs, UseRisksArgs, UseAuditArgs, UseTrainingArgs, UseAccessAuditArgs, AccessAuditLog, AccessAuditFilter, OrgUserRow, UseOrgUsersArgs } from './registers.types';
import { noop } from './useRopa';
export { useDsr } from './useDsr';
export { useRopa } from './useRopa';
export type { OrgUserRow } from './registers.types';
/**
 * Shared busy/mutate wrapper: set busy → run → refresh → toast on failure.
 * Keeps its historic name `_isoMutate`: the i18n guard registers it as a
 * helper that takes a key as an ARGUMENT (KEY_ARG_HELPERS), so every
 * `errKey` below is checked against the dictionary like a t() call.
 */
function useIsoMutate(refresh: () => Promise<unknown>, onChanged: () => void) {
    return useCallback(async (setBusy: (value: Id | null) => void, busyKey: Id, fn: () => Promise<unknown>, errKey: string, errFallback: string, t: TranslateFn) => {
        setBusy(busyKey);
        try { await fn(); await refresh(); onChanged?.(); }
        catch (e) { toast.error(t(errKey, errFallback)); }
        finally { setBusy(null); }
    }, [refresh, onChanged]);
}

// ── DPIA ───────────────────────────────────────────────────────────────────
export function useDpia({ enabled = false, onChanged = noop, refreshCore = noop }: UseDpiaArgs = {}) {
    const { t } = useTranslation();
    const res = useResource<DpiaRecord[]>(`${API}/dpia`, {
        enabled, parse: (b) => (asArray(b) ?? []) as DpiaRecord[],
        onError: (e: unknown) => { console.error('[ComplianceHub] DPIA fetch error:', (e as Error).message); return []; },
    });
    const [savingId, setSavingId] = useState<Id | null>(null);
    const save = async (agentId: Id, body: unknown) => {
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
    const pdfUrlFor = (agentId: string | number | boolean) => `${API}/dpia/${encodeURIComponent(agentId)}/pdf`;
    return { dpiaList: res.data, savingId, refresh: res.refresh, save, pdfUrlFor };
}

// ── Incidents (Art. 33/34 + CRA vulnerability register) ────────────────────
export function useIncidents({ enabled = false, onChanged = noop, refreshCore = noop, kind = null }: UseIncidentsArgs = {}) {
    const { t } = useTranslation();
    const url = kind ? `${API}/incidents?kind=${encodeURIComponent(kind)}` : `${API}/incidents`;
    const res = useResource(url, {
        enabled, parse: (b) => asArray(b) ?? ((b as { incidents?: unknown[] } | null) && Array.isArray((b as { incidents?: unknown[] }).incidents) ? (b as { incidents: unknown[] }).incidents : []),
        onError: (e: unknown) => { console.error('[ComplianceHub] incidents fetch error:', (e as Error).message); return []; },
    });
    const [busyId, setBusyId] = useState<Id | null>(null);
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
    const update = async (id: Id, body: unknown) => {
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
    const notify = async (id: Id) => {
        setBusyId(id);
        try {
            const r = await fetchJson(`${API}/incidents/${encodeURIComponent(id)}/notify-recipients`, { method: 'POST' });
            await res.refresh();
            toast.success(t('compliance.inc_toast_notified', { count: r?.notified ?? '' }) ||
                `Breach recipients notified (${r?.notified ?? 0})`);
        } catch (e) {
            toast.error(t('compliance.inc_toast_notify_failed', 'Could not send the notification — check breach recipients and SMTP'));
        } finally { setBusyId(null); }
    };
    const craReport = async (id: Id, body: unknown) => {
        setBusyId(id);
        try { await fetchJson(`${API}/incidents/${encodeURIComponent(id)}/cra-report`, json(body)); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.vuln_toast_report_failed', 'Could not record the report')); }
        finally { setBusyId(null); }
    };
    const customerNotified = async (id: Id) => {
        setBusyId(id);
        try { await fetchJson(`${API}/incidents/${encodeURIComponent(id)}/customer-notified`, json({})); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.inc_toast_failed', 'Could not save the incident')); }
        finally { setBusyId(null); }
    };
    return { incidents: res.data, busyId, refresh: res.refresh, create, update, notify, craReport, customerNotified };
}

// ── ISO SoA ────────────────────────────────────────────────────────────────
export function useSoa({ enabled = false, onChanged = noop }: UseSoaArgs = {}) {
    const { t } = useTranslation();
    const res = useResource<SoaBody>(`${API}/iso/soa`, { enabled, onError: (e: unknown) => ({ error: (e as Error).message }) });
    const [busyRef, setBusyRef] = useState<Id | null>(null);
    const seed = async () => {
        setBusyRef('seed');
        try {
            const r = await fetchJson(`${API}/iso/soa/seed`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.soa_toast_seeded', { count: r?.inserted ?? 0 }) || `Seeded ${r?.inserted ?? 0} SoA rows`);
        } catch (e) {
            toast.error(t('compliance.soa_toast_seed_failed', 'Could not seed the SoA'));
        } finally { setBusyRef(null); }
    };
    const update = async (ref: Id, patch: unknown) => {
        setBusyRef(ref);
        try {
            await fetchJson(`${API}/iso/soa/${encodeURIComponent(ref)}`, jsonInit('PUT', patch));
            await res.refresh(); onChanged();
        } catch (e) {
            toast.error(t('compliance.soa_toast_save_failed', 'Could not save the SoA row'));
        } finally { setBusyRef(null); }
    };
    const loadHistory = () => fetchJson(`${API}/iso/soa/history`).then(asArray);
    return { soa: res.data, busyRef, refresh: res.refresh, seed, update, loadHistory };
}

// ── ISMS policy documents ──────────────────────────────────────────────────
export function usePolicies({ enabled = false, onChanged = noop }: UsePoliciesArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/iso/docs`, { enabled, onError: (e: unknown) => ({ error: (e as Error).message, documents: [], missing_seeds: [] }) });
    const [busySlug, setBusySlug] = useState<Id | null>(null);
    const seed = async () => {
        setBusySlug('seed');
        try {
            const r = await fetchJson(`${API}/iso/docs/seed`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.policies_toast_seeded', { count: r?.inserted ?? 0 }) || `Seeded ${r?.inserted ?? 0} policy templates`);
        } catch (e) {
            toast.error(t('compliance.policies_toast_seed_failed', 'Could not seed policy templates'));
        } finally { setBusySlug(null); }
    };
    const loadDoc = async (slug: string | number | boolean) => {
        try { return await fetchJson(`${API}/iso/docs/${encodeURIComponent(slug)}`); }
        catch { return null; }
    };
    const save = async (slug: Id, patch: unknown) => {
        setBusySlug(slug);
        try {
            await fetchJson(`${API}/iso/docs/${encodeURIComponent(slug)}`, jsonInit('PUT', patch));
            await res.refresh();
        } catch (e) {
            toast.error(t('compliance.policies_toast_save_failed', 'Could not save the document'));
        } finally { setBusySlug(null); }
    };
    const publish = async (slug: Id) => {
        setBusySlug(slug);
        try {
            const doc = await fetchJson(`${API}/iso/docs/${encodeURIComponent(slug)}/publish`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.policies_toast_published', { version: doc?.current_version ?? '' }) || `Published v${doc?.current_version}`);
        } catch (e) {
            toast.error(t('compliance.policies_toast_publish_failed', 'Could not publish the document'));
        } finally { setBusySlug(null); }
    };
    return { docs: res.data, busySlug, refresh: res.refresh, seed, loadDoc, save, publish };
}

// ── Evidence connectors ────────────────────────────────────────────────────
export function useConnectors({ enabled = false, onChanged = noop }: UseConnectorsArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/iso/connectors`, { enabled, parse: (b) => asArray(b) ?? [], onError: () => [] });
    const [busyId, setBusyId] = useState<Id | null>(null);
    const save = async (id: Id, patch: unknown) => {
        setBusyId(id);
        try {
            await fetchJson(`${API}/iso/connectors/${encodeURIComponent(id)}`, jsonInit('PUT', patch));
            await res.refresh(); onChanged();
            toast.success(t('compliance.conn_toast_saved', 'Connector saved'));
        } catch (e) {
            toast.error(t('compliance.conn_toast_save_failed', 'Could not save the connector'));
        } finally { setBusyId(null); }
    };
    const sweep = async (id: Id) => {
        setBusyId(id);
        try {
            const r = await fetchJson(`${API}/iso/connectors/${encodeURIComponent(id)}/sweep`, json({}));
            await res.refresh(); onChanged();
            toast.success(t('compliance.conn_toast_swept', { subjects: r?.subjects ?? 0, changed: r?.changed ?? 0 }) || `Sweep done — ${r?.subjects ?? 0} subject(s), ${r?.changed ?? 0} changed`);
        } catch (e) {
            await res.refresh();
            toast.error(t('compliance.conn_toast_sweep_failed', 'Sweep failed — check the credential and settings'));
        } finally { setBusyId(null); }
    };
    const loadConnections = async (id: string | number | boolean) => {
        try { return await fetchJson(`${API}/iso/connectors/${encodeURIComponent(id)}/connections`); }
        catch { return []; }
    };
    return { connectors: res.data, busyId, refresh: res.refresh, save, sweep, loadConnections };
}

// ── Risk register ──────────────────────────────────────────────────────────
export function useRisks({ enabled = false, onChanged = noop }: UseRisksArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/iso/risks`, { enabled, onError: (e: unknown) => ({ risks: [], treatments: [], stats: null, error: (e as Error).message }) });
    const [busyId, setBusyId] = useState<Id | null>(null);
    const _isoMutate = useIsoMutate(res.refresh, onChanged);
    const create = (fields: unknown) => _isoMutate(setBusyId, 'create',
        () => fetchJson(`${API}/iso/risks`, json(fields)),
        'compliance.risk_toast_failed', 'Could not save the risk', t);
    const update = (id: Id, patch: unknown) => _isoMutate(setBusyId, id,
        () => fetchJson(`${API}/iso/risks/${id}`, jsonInit('PUT', patch)),
        'compliance.risk_toast_failed', 'Could not save the risk', t);
    const addTreatment = (riskId: Id, fields: unknown) => _isoMutate(setBusyId, riskId,
        () => fetchJson(`${API}/iso/risks/${riskId}/treatments`, json(fields)),
        'compliance.risk_treatment_toast_failed', 'Could not save the treatment', t);
    const seed = () => _isoMutate(setBusyId, 'seed',
        async () => {
            const r = await fetchJson(`${API}/iso/risks/seed`, json({}));
            toast.success(t('compliance.risk_toast_seeded', 'Seeded {count} risk scenario(s)', { count: r?.inserted ?? 0 }));
        },
        'compliance.risk_seed_toast_failed', 'Could not seed risks', t);
    return {
        risks: res.data?.risks ?? (res.data ? [] : null), treatments: res.data?.treatments || [], stats: res.data?.stats || null,
        busyId, refresh: res.refresh, create, update, addTreatment, seed,
    };
}

// ── Audits & management review ─────────────────────────────────────────────
export function useAudit({ enabled = false, onChanged = noop }: UseAuditArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/iso/audit`, { enabled, onError: (e: unknown) => ({ audits: [], findings: [], reviews: [], ncs: [], objectives: [], mr_inputs: null, error: (e as Error).message }) });
    const [busy, setBusy] = useState(false);
    const [independenceWarning, setIndependenceWarning] = useState<string | null>(null);
    const run = async (fn: () => Promise<unknown>) => {
        setBusy(true);
        try { await fn(); await res.refresh(); onChanged(); }
        catch (e) { toast.error(t('compliance.audit_toast_failed', 'Could not save — try again')); }
        finally { setBusy(false); }
    };
    const createAudit = async (fields: { auditor_user_id?: Id } & Record<string, unknown>) => {
        // Independence probe (9.2.2): record the conflict before the audit exists.
        if (fields?.auditor_user_id) {
            try {
                const ind = await fetchJson(`${API}/iso/audit/independence/${encodeURIComponent(fields.auditor_user_id)}`);
                setIndependenceWarning(ind?.independent === false
                    ? t('compliance.audit_independence_warning',
                        'Independence conflict: this auditor {conflicts}',
                        { conflicts: (ind.conflicts || []).join('; ') })
                    : null);
            } catch { setIndependenceWarning(null); }
        }
        return run(() => fetchJson(`${API}/iso/audits`, json(fields)));
    };
    const updateAudit = (id: Id, patch: unknown) => run(() => fetchJson(`${API}/iso/audits/${id}`, jsonInit('PUT', patch)));
    const addFinding = (auditId: Id, fields: unknown) => run(() => fetchJson(`${API}/iso/audits/${auditId}/findings`, json(fields)));
    const createReview = (fields: object) => run(() => fetchJson(`${API}/iso/reviews`, json({ ...fields, inputs: res.data?.mr_inputs || {} })));
    const createNc = (fields: unknown) => run(() => fetchJson(`${API}/iso/ncs`, json(fields)));
    const updateNc = (id: Id, patch: unknown) => run(() => fetchJson(`${API}/iso/ncs/${id}`, jsonInit('PUT', patch)));
    const createObjective = (fields: unknown) => run(() => fetchJson(`${API}/iso/objectives`, json(fields)));
    const updateObjective = (id: Id, patch: unknown) => run(() => fetchJson(`${API}/iso/objectives/${id}`, jsonInit('PUT', patch)));
    return {
        audits: res.data?.audits ?? (res.data ? [] : null), findings: res.data?.findings || [], reviews: res.data?.reviews || [],
        ncs: res.data?.ncs || [], objectives: res.data?.objectives || [], mrInputs: res.data?.mr_inputs || null,
        busy, independenceWarning, refresh: res.refresh,
        createAudit, updateAudit, addFinding, createReview, createNc, updateNc, createObjective, updateObjective,
    };
}

// ── Training & competence ──────────────────────────────────────────────────
export function useTraining({ enabled = false, onChanged = noop }: UseTrainingArgs = {}) {
    const { t } = useTranslation();
    const res = useResource(`${API}/iso/training`, { enabled, onError: (e: unknown) => ({ personnel: [], obligations: [], error: (e as Error).message }) });
    const [busyId, setBusyId] = useState<Id | null>(null);
    const _isoMutate = useIsoMutate(res.refresh, onChanged);
    const attest = (userId: Id, note: unknown) => _isoMutate(setBusyId, userId,
        () => fetchJson(`${API}/iso/training/${encodeURIComponent(userId)}/attest`, json({ note })),
        'compliance.training_toast_failed', 'Could not record the attestation', t);
    const createObligation = (fields: unknown) => _isoMutate(setBusyId, 'create',
        () => fetchJson(`${API}/iso/obligations`, json(fields)),
        'compliance.obl_toast_failed', 'Could not save the obligation', t);
    const completeObligation = (id: Id) => _isoMutate(setBusyId, id,
        () => fetchJson(`${API}/iso/obligations/${id}/complete`, json({})),
        'compliance.obl_complete_toast_failed', 'Could not complete the obligation', t);
    return {
        personnel: res.data?.personnel ?? (res.data ? [] : null), obligations: res.data?.obligations ?? (res.data ? [] : null),
        busyId, refresh: res.refresh, attest, createObligation, completeObligation,
    };
}
// ── Access & authentication trail (A.8.15) ─────────────────────────────────
// Filtering and paging go to the SERVER. A client-side filter over one page
// would answer a different question than the operator typed: "every refused
// sign-in this month" would silently mean "…on this page".
export function useAccessAudit({ enabled = false }: UseAccessAuditArgs = {}) {
    const [data, setData] = useState<AccessAuditLog | null>(null);
    // An entry may be a bare action string (no count) as well as { action, count }.
    const [actions, setActions] = useState<Array<string | { action: string; count?: number }>>([]);
    const [filter, setFilter] = useState<AccessAuditFilter>({});
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
        fetchJson(`${API}/access-audit?${q.toString()}`)
            .then((d) => { if (!cancelled) setData(d); })
            .catch((e) => { if (!cancelled) setData({ error: e.message }); });
        fetchJson(`${API}/access-audit/actions?${query.toString()}`)
            .then((d) => { if (!cancelled) setActions(d?.actions || []); })
            // The filter control is a convenience; losing it must not blank the log.
            .catch(() => { if (!cancelled) setActions([]); });
        return () => { cancelled = true; };
    }, [enabled, query, offset]);
    return {
        data, actions, filter, offset, exportError,
        setFilter: (f: AccessAuditFilter | ((prev: AccessAuditFilter) => AccessAuditFilter)) => { setFilter(f); setOffset(0); }, setOffset,
        exportUrl: `${API}/access-audit/export?${query.toString()}`,
    };
}

// ── Org member directory (pickers) ─────────────────────────────────────────
// Fetched only for the sections that show a picker — the nav test pins that
// the GDPR page never asks for the directory. null = not loaded; [] = failed
// or empty (pickers hide, free text stays available).
export function useOrgUsers({ enabled = false }: UseOrgUsersArgs = {}) {
    const res = useResource<OrgUserRow[]>(`${API}/org-users`, { enabled, parse: (b) => (asArray(b) ?? []) as OrgUserRow[], onError: () => [] });
    return { orgUsers: res.data, refresh: res.refresh };
}
