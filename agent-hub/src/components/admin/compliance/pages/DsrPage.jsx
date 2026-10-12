/**
 * Compliance → Data-subject requests (artboard 1c). Replaces DsrInboxPage.
 *
 * Coded against the hub's page props (PLAN-FRONTEND C2/C3):
 *   { section, tab, onTab, navigate, focusId, exportsEnabled, dl, data:{ dsr, core, orgUsers, … }, isMobile }
 * where `data.dsr` = { requests, busyId, refresh, fulfil, capture, start, extend,
 * verifyIdentity, loadTimeline, loadDiscovery, exportUrlFor } and `data.orgUsers`
 * names the handlers in the drawer's timeline. Every one of those is optional:
 * a missing piece falls back to data/api.js `fetchJson` against /api/dsr, so
 * the page works before useDsr.js exists and degrades (404 → hidden section)
 * before BE-2's routes exist.
 *
 * The header's primary "Record a request" opens the capture modal through the
 * imperative handle (`ref.current.openCapture()`) or by bumping the
 * `captureSignal` prop — the hub picks whichever fits.
 *
 * Two tabs: Requests and Public form. The DPO and acknowledgement settings
 * are a rail item of their own (sections.js maps an old `?tab=settings` there).
 * Where the drawer goes follows the width the register has (useDrawerMode):
 * beside the table, floating over it, or a dialog on a phone.
 */
import { ArrowUpRight, Plus, RefreshCw, Search, Timer } from 'lucide-react';
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { useNow } from '../../../shared/DeadlineClock';
import FilterPills from '../../../shared/FilterPills';
import { toast } from '../../../shared/Toast';
import { API_DSR, asArray, downloadUrl, fetchJson, json } from '../data/api';
import useDrawerMode from '../shared/useDrawerMode';
import { PAGE_FRAME, RegisterLayout } from './audits/auditForms';
import { FILTERS, countByFilter, matchesFilter, matchesQuery, sortByDeadline } from './dsr/dsrArticles';
import DsrCaptureModal from './dsr/DsrCaptureModal';
import DsrDrawer from './dsr/DsrDrawer';
import DsrTable, { shownEmailOf } from './dsr/DsrTable';
import PublicFormTab, { publicDsrUrl } from './dsr/PublicFormTab';

export const DRAWER_WIDTH = 380;

const FILTER_TONE = Object.freeze({ open: 'neutral', overdue: 'error', fulfilled: 'neutral', rejected: 'muted' });
const FILTER_LABEL = Object.freeze({
    open: ['compliance.dsr_filter_open', 'Open'],
    overdue: ['compliance.dsr_filter_overdue', 'Overdue'],
    fulfilled: ['compliance.dsr_filter_fulfilled', 'Completed'],
    rejected: ['compliance.dsr_filter_rejected', 'Rejected'],
});

/**
 * What the hub's ComplianceHeader shows for this section (C5 "dsr"). Pure:
 * the hub renders it. `overdue` undefined → the neutral pill (never "0").
 */
export function dsrHeaderSpec(t, { overdue, onRefresh, onCapture, refreshing = false } = {}) {
    const hasOverdue = typeof overdue === 'number' && overdue > 0;
    return {
        pill: hasOverdue
            ? { tone: 'error', icon: Timer, label: t('compliance.hdr_dsr_overdue', '{n} past the deadline', { n: overdue }) }
            : { tone: 'neutral', icon: Timer, label: t('compliance.hdr_dsr_ok', 'All requests within the deadline') },
        infoChip: { icon: Timer, label: t('compliance.hdr_dsr_window', 'Art. 12–22 · one month, +2 months with reason') },
        secondary: { icon: RefreshCw, iconOnly: true, ariaLabel: t('compliance.dsr_refresh', 'Refresh'), onClick: onRefresh, busy: refreshing },
        primary: { icon: Plus, label: t('compliance.dsr_capture_cta', 'Record a request'), onClick: onCapture },
    };
}

/**
 * The register's data source: the hub's `data.dsr` where it exists, a local
 * fetchJson fallback for everything it does not (yet) provide.
 */
export const dsrUrl = (id, tail = '') => `${API_DSR}/requests/${encodeURIComponent(id)}${tail}`;

function useDsrSource(dsr, enabled = true) {
    const hasList = Boolean(dsr && 'requests' in dsr);
    // `undefined` = not asked yet, `null` = the read failed, array = loaded.
    const [local, setLocal] = useState(undefined);
    const [localBusy, setLocalBusy] = useState(null);

    const localRefresh = useCallback(async () => {
        try {
            const body = await fetchJson(`${API_DSR}/requests`);
            const rows = asArray(body) ?? asArray(body?.requests) ?? asArray(body?.items);
            setLocal(rows);                       // junk body → null → "could not read"
        } catch {
            setLocal(null);
        }
    }, []);

    useEffect(() => {
        if (!hasList && enabled && local === undefined) localRefresh();
    }, [hasList, enabled, local, localRefresh]);

    const refresh = dsr?.refresh ?? localRefresh;

    const busyRun = useCallback(async (id, run) => {
        setLocalBusy(id);
        try { return await run(); } finally { setLocalBusy(null); }
    }, []);

    const localFulfil = useCallback((id, body) => busyRun(id, async () => { await fetchJson(dsrUrl(id, '/fulfil'), json(body)); await refresh(); }), [busyRun, refresh]);
    const localStart = useCallback((id) => busyRun(id, async () => { await fetchJson(dsrUrl(id, '/start'), json()); await refresh(); }), [busyRun, refresh]);
    const localExtend = useCallback((id, reason) => busyRun(id, async () => { await fetchJson(dsrUrl(id, '/extend'), json({ reason })); await refresh(); }), [busyRun, refresh]);
    const localVerify = useCallback((id, body) => busyRun(id, async () => { await fetchJson(dsrUrl(id, '/verify-identity'), json(body)); await refresh(); }), [busyRun, refresh]);
    const localCapture = useCallback((body) => busyRun('capture', async () => { const r = await fetchJson(`${API_DSR}/requests/manual`, json(body)); await refresh(); return r; }), [busyRun, refresh]);
    const localTimeline = useCallback((id) => fetchJson(dsrUrl(id, '/timeline')).then(b => asArray(b) ?? asArray(b?.timeline) ?? null), []);
    const localDiscovery = useCallback((id) => fetchJson(dsrUrl(id, '/discovery')), []);
    const localExportUrl = useCallback((id) => dsrUrl(id, '/export'), []);

    const requests = hasList ? dsr.requests : local;
    return {
        // The page reads `null` as "loading" and `failed` as its own state.
        requests: requests === undefined ? null : requests,
        failed: hasList ? Boolean(dsr.failed) : local === null,
        busyId: dsr?.busyId ?? localBusy,
        refresh,
        fulfil: dsr?.fulfil ?? localFulfil,
        start: dsr?.start ?? localStart,
        extend: dsr?.extend ?? localExtend,
        verifyIdentity: dsr?.verifyIdentity ?? localVerify,
        capture: dsr?.capture ?? localCapture,
        loadTimeline: dsr?.loadTimeline ?? localTimeline,
        loadDiscovery: dsr?.loadDiscovery ?? localDiscovery,
        exportUrlFor: dsr?.exportUrlFor ?? localExportUrl,
        // Which writes came from the hub's useDsr — it toasts some of them
        // itself, so the page must stay quiet there or the user sees two.
        fromHook: {
            fulfil: Boolean(dsr?.fulfil),
            start: Boolean(dsr?.start),
            extend: Boolean(dsr?.extend),
            verifyIdentity: Boolean(dsr?.verifyIdentity),
            capture: Boolean(dsr?.capture),
        },
    };
}

/**
 * What registers/useDsr already toasts per action (see data/registers.js):
 * `fulfil` reports both outcomes, `capture` only its success, `extend` only
 * its failure, `start` and `verifyIdentity` nothing. `true` = the hook says
 * it, so we do not.
 */
const HOOK_TOASTS = Object.freeze({
    fulfil: { success: true, error: true },
    capture: { success: true, error: false },
    extend: { success: false, error: true },
    start: { success: false, error: false },
    verifyIdentity: { success: false, error: false },
});

const DsrPage = forwardRef(function DsrPage({
    tab = 'requests',
    navigate,
    focusId = null,
    exportsEnabled = true,
    dl,
    data,
    isMobile = false,
    setHeaderActions,
    captureSignal = 0,
    onCountsChange,
}, ref) {
    const { t } = useTranslation();
    const now = useNow();
    const src = useDsrSource(data?.dsr, tab !== 'public_form');
    const [frameRef, drawerMode] = useDrawerMode({ isMobile, drawerWidth: DRAWER_WIDTH });

    const [filter, setFilter] = useState('open');
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState(focusId !== null && focusId !== undefined ? String(focusId) : null);
    const [captureOpen, setCaptureOpen] = useState(false);

    useEffect(() => { if (focusId !== null && focusId !== undefined) setSelectedId(String(focusId)); }, [focusId]);
    useEffect(() => { if (captureSignal) setCaptureOpen(true); }, [captureSignal]);
    useImperativeHandle(ref, () => ({ openCapture: () => setCaptureOpen(true), refresh: () => src.refresh() }), [src.refresh]);

    // The header's primary ("Record a request") is rendered by the hub; the
    // modal lives here, so the hub gets the handle and loses it on unmount.
    useEffect(() => {
        if (!setHeaderActions) return undefined;
        setHeaderActions({ onCaptureRequest: () => setCaptureOpen(true) });
        return () => setHeaderActions({});
    }, [setHeaderActions]);

    const loaded = Array.isArray(src.requests);
    const counts = useMemo(() => (loaded ? countByFilter(src.requests, now) : null), [loaded, src.requests, now]);
    useEffect(() => { if (counts && onCountsChange) onCountsChange(counts); }, [counts, onCountsChange]);

    const visible = useMemo(() => {
        if (!loaded) return [];
        const rows = src.requests.filter(r => matchesFilter(r, filter, now) && matchesQuery(r, query, shownEmailOf(r)));
        return sortByDeadline(rows);
    }, [loaded, src.requests, filter, query, now]);

    const selected = useMemo(() => (loaded && selectedId !== null ? src.requests.find(r => String(r.id) === selectedId) ?? null : null), [loaded, src.requests, selectedId]);

    // The selected row must be reachable in the current filter — when it is
    // not (it was just fulfilled under "open"), keep the drawer open anyway.
    const drawerOpen = Boolean(selected);

    const dlUrl = (url) => (dl ? dl(url) : downloadUrl(exportsEnabled, url));

    /**
     * Run one write and say what happened — unless the hub's useDsr already
     * said it (HOOK_TOASTS), in which case we stay quiet rather than toast twice.
     */
    const act = async (action, run, okKey, okEn) => {
        const said = src.fromHook[action] ? HOOK_TOASTS[action] : null;
        try {
            await run();
            if (!said?.success) toast.success(t(okKey, okEn));
        } catch {
            if (!said?.error) toast.error(t('compliance.dsr_toast_update_failed', 'Could not update the request'));
        }
    };

    const onFulfil = (body) => selected && act(
        'fulfil',
        () => src.fulfil(selected.id, body),
        body.status === 'rejected' ? 'compliance.dsr_toast_rejected' : 'compliance.dsr_toast_fulfilled',
        body.status === 'rejected' ? 'Request rejected — the data subject has been e-mailed' : 'Request fulfilled — the data subject has been e-mailed',
    );
    const onExtend = (reason) => selected && act('extend', () => src.extend(selected.id, reason), 'compliance.dsr_toast_extended', 'Deadline extended by two months');
    const onStart = () => selected && act('start', () => src.start(selected.id), 'compliance.dsr_toast_started', 'Request started');
    const onVerifyIdentity = (body) => selected && act('verifyIdentity', () => src.verifyIdentity(selected.id, body), 'compliance.dsr_toast_identity_verified', 'Identity confirmed');
    const onCapture = async (body) => {
        const said = src.fromHook.capture ? HOOK_TOASTS.capture : null;
        try {
            await src.capture(body);
            setCaptureOpen(false);
            if (!said?.success) toast.success(t('compliance.dsr_toast_captured', 'Request recorded — the one-month clock is running'));
        } catch {
            if (!said?.error) toast.error(t('compliance.dsr_toast_capture_failed', 'Could not record the request'));
        }
    };

    const publicUrl = publicDsrUrl(data?.core?.overview?.settings);
    const openSettings = () => navigate?.('settings');

    const pills = FILTERS.map(f => ({
        value: f,
        label: t(...FILTER_LABEL[f]),
        tone: FILTER_TONE[f],
        count: counts ? counts[f] : undefined,
    }));

    if (tab === 'public_form') {
        return (
            <div className={`h-full overflow-y-auto ${PAGE_FRAME}`} data-testid="dsr-page" data-tab="public_form">
                <PublicFormTab publicUrl={publicUrl} onOpenSettings={openSettings} onCopied={(ok) => ok && toast.success(t('common.copied', 'Copied to clipboard'))} />
            </div>
        );
    }

    const drawer = drawerOpen ? (
        <DsrDrawer
            request={selected}
            open
            onClose={() => setSelectedId(null)}
            mode={drawerMode}
            width={DRAWER_WIDTH}
            busy={src.busyId === selected.id}
            exportUrl={dlUrl(src.exportUrlFor(selected.id))}
            onFulfil={onFulfil}
            onReject={onFulfil}
            onExtend={onExtend}
            onStart={onStart}
            onVerifyIdentity={onVerifyIdentity}
            loadTimeline={src.loadTimeline}
            loadDiscovery={src.loadDiscovery}
            orgUsers={data?.orgUsers ?? null}
        />
    ) : null;

    const searchLabel = t('compliance.dsr_search_short', 'Search # or e-mail');
    const toolbar = (
        <>
            <FilterPills value={filter} onChange={setFilter} options={pills} ariaLabel={t('compliance.dsr_filter_aria', 'Filter requests')} testId="dsr-filter" />
            <a href={publicUrl} target="_blank" rel="noopener noreferrer"
                className="ml-auto max-md:ml-0 whitespace-nowrap inline-flex items-center gap-1 text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                data-testid="dsr-public-form-link">
                {t('compliance.dsr_public_form_link', 'Public form')}<ArrowUpRight size={12} aria-hidden="true" />
            </a>
            <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-tertiary)] w-[220px] max-md:w-full">
                <Search size={13} aria-hidden="true" className="shrink-0" />
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder={searchLabel}
                    className="min-w-0 flex-1 bg-transparent outline-none text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                    data-testid="dsr-search"
                    aria-label={searchLabel}
                />
            </label>
        </>
    );

    return (
        <>
            <RegisterLayout toolbar={toolbar} drawer={drawer} isMobile={isMobile} drawerMode={drawerMode} frameRef={frameRef} testId="dsr-page">
                <DsrTable
                    rows={visible}
                    loading={src.requests === null && !src.failed}
                    failed={src.failed}
                    selectedId={selectedId}
                    onSelect={(row) => setSelectedId(String(row.id))}
                    isMobile={isMobile}
                />
                {loaded && visible.length === 0 && src.requests.length > 0 && (
                    <div className="text-[11px] text-[var(--text-tertiary)] px-1" data-testid="dsr-filter-empty">
                        {t('compliance.dsr_filter_empty', 'No requests match this filter.')}
                    </div>
                )}
            </RegisterLayout>
            <DsrCaptureModal open={captureOpen} onClose={() => setCaptureOpen(false)} onCapture={onCapture} busy={src.busyId === 'capture'} />
        </>
    );
});

export default DsrPage;
