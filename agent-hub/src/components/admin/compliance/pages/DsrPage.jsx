/**
 * Compliance → Data-subject requests (artboard 1c). Replaces DsrInboxPage.
 *
 * Coded against the hub's page props (PLAN-FRONTEND C2/C3):
 *   { section, tab, onTab, navigate, focusId, exportsEnabled, dl, data:{ dsr, core, … }, isMobile }
 * where `data.dsr` = { requests, busyId, refresh, fulfil, capture, start, extend,
 * loadTimeline, loadDiscovery, exportUrlFor }. Every one of those is optional:
 * a missing piece falls back to data/api.js `fetchJson` against /api/dsr, so
 * the page works before useDsr.js exists and degrades (404 → hidden section)
 * before BE-2's routes exist.
 *
 * The header's primary "Record a request" opens the capture modal through the
 * imperative handle (`ref.current.openCapture()`) or by bumping the
 * `captureSignal` prop — the hub picks whichever fits.
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { ArrowDownNarrowWide, ArrowUpRight, Globe, Plus, RefreshCw, Search, Settings2, Timer } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FilterPills from '../../../shared/FilterPills';
import { useNow } from '../../../shared/DeadlineClock';
import { toast } from '../../../shared/Toast';
import { API_DSR, asArray, downloadUrl, fetchJson, json } from '../data/api';
import DsrTable, { shownEmailOf } from './dsr/DsrTable';
import DsrDrawer from './dsr/DsrDrawer';
import DsrCaptureModal from './dsr/DsrCaptureModal';
import PublicFormTab, { publicDsrUrl } from './dsr/PublicFormTab';
import { FILTERS, countByFilter, matchesFilter, matchesQuery, sortByDeadline } from './dsr/dsrArticles';

export const DRAWER_INLINE_MIN_WIDTH = 1180;
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
        infoChip: { icon: Timer, label: t('compliance.hdr_dsr_window', 'Art. 12–22 · 30 days, +60 with reason') },
        secondary: { icon: RefreshCw, iconOnly: true, ariaLabel: t('compliance.dsr_refresh', 'Refresh'), onClick: onRefresh, busy: refreshing },
        primary: { icon: Plus, label: t('compliance.dsr_capture_cta', 'Record a request'), onClick: onCapture },
    };
}

function useMinWidth(px) {
    const query = `(min-width: ${px}px)`;
    const read = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : true);
    const [wide, setWide] = useState(read);
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const mq = window.matchMedia(query);
        const on = () => setWide(mq.matches);
        on();
        mq.addEventListener?.('change', on);
        return () => mq.removeEventListener?.('change', on);
    }, [query]);
    return wide;
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
            capture: Boolean(dsr?.capture),
        },
    };
}

/**
 * What registers/useDsr already toasts per action (see data/registers.js):
 * `fulfil` reports both outcomes, `capture` only its success, `extend` only
 * its failure, `start` nothing. `true` = the hook says it, so we do not.
 */
const HOOK_TOASTS = Object.freeze({
    fulfil: { success: true, error: true },
    capture: { success: true, error: false },
    extend: { success: false, error: true },
    start: { success: false, error: false },
});

function SettingsTab({ onOpenSettings }) {
    const { t } = useTranslation();
    return (
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 flex flex-col gap-3 max-w-[720px]" data-testid="dsr-settings-tab">
            <div className="flex items-center gap-2">
                <Settings2 size={14} aria-hidden="true" style={{ color: 'var(--kind-compliance)' }} />
                <span className="font-semibold text-[13px]">{t('compliance.tab_dsr_settings', 'Settings')}</span>
            </div>
            <p className="m-0 text-[12px] text-[var(--text-secondary)] leading-5">
                {t('compliance.dsr_settings_intro', 'The DPO contact, the acknowledgement e-mail and the public form link live with the other compliance settings.')}
            </p>
            <button type="button" onClick={onOpenSettings}
                className="self-start inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)]"
                data-testid="dsr-settings-open">
                {t('compliance.dsr_settings_open', 'Open compliance settings')}<ArrowUpRight size={12} aria-hidden="true" />
            </button>
        </div>
    );
}

const DsrPage = forwardRef(function DsrPage({
    tab = 'requests',
    onTab,
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
    const src = useDsrSource(data?.dsr, tab === 'requests');
    const wide = useMinWidth(DRAWER_INLINE_MIN_WIDTH);

    const [filter, setFilter] = useState('open');
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState(focusId !== null && focusId !== undefined ? String(focusId) : null);
    const [captureOpen, setCaptureOpen] = useState(false);
    const [refreshing, setRefreshing] = useState(false);

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
    const drawerMode = isMobile ? 'modal' : wide ? 'inline' : 'overlay';

    const dlUrl = (url) => (dl ? dl(url) : downloadUrl(exportsEnabled, url));

    const refresh = async () => {
        setRefreshing(true);
        try { await src.refresh(); } finally { setRefreshing(false); }
    };

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
    const onExtend = (reason) => selected && act('extend', () => src.extend(selected.id, reason), 'compliance.dsr_toast_extended', 'Deadline extended by 60 days');
    const onStart = () => selected && act('start', () => src.start(selected.id), 'compliance.dsr_toast_started', 'Request started');
    const onCapture = async (body) => {
        const said = src.fromHook.capture ? HOOK_TOASTS.capture : null;
        try {
            await src.capture(body);
            setCaptureOpen(false);
            if (!said?.success) toast.success(t('compliance.dsr_toast_captured', 'Request recorded — the 30-day clock runs from receipt'));
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
            <div className="h-full overflow-y-auto px-7 py-[18px] max-md:px-4" data-testid="dsr-page" data-tab="public_form">
                <PublicFormTab publicUrl={publicUrl} onOpenSettings={openSettings} onCopied={(ok) => ok && toast.success(t('common.copied', 'Copied to clipboard'))} />
            </div>
        );
    }
    if (tab === 'settings') {
        return (
            <div className="h-full overflow-y-auto px-7 py-[18px] max-md:px-4" data-testid="dsr-page" data-tab="settings">
                <SettingsTab onOpenSettings={openSettings} />
            </div>
        );
    }

    const drawer = (
        <DsrDrawer
            request={selected}
            open={drawerOpen}
            onClose={() => setSelectedId(null)}
            mode={drawerMode}
            width={DRAWER_WIDTH}
            busy={selected ? src.busyId === selected.id : false}
            exportUrl={selected ? dlUrl(src.exportUrlFor(selected.id)) : null}
            onFulfil={onFulfil}
            onReject={onFulfil}
            onExtend={onExtend}
            onStart={onStart}
            loadTimeline={src.loadTimeline}
            loadDiscovery={src.loadDiscovery}
        />
    );

    const inline = drawerOpen && drawerMode === 'inline';

    return (
        <div className="relative h-full min-h-0 overflow-hidden px-7 py-[18px] max-md:px-4 text-[12px]" data-testid="dsr-page" data-tab="requests" data-drawer={drawerOpen ? drawerMode : undefined}>
            <div className="h-full min-h-0 grid gap-4" style={{ gridTemplateColumns: inline ? `1fr ${DRAWER_WIDTH}px` : '1fr' }}>
                <div className="flex flex-col gap-3 min-h-0 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <FilterPills value={filter} onChange={setFilter} options={pills} ariaLabel={t('compliance.dsr_filter_aria', 'Filter requests')} testId="dsr-filter" />
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]" data-testid="dsr-sort-note">
                            <ArrowDownNarrowWide size={12} aria-hidden="true" />{t('compliance.dsr_sort_deadline', 'By deadline')}
                        </span>
                        <label className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-tertiary)] w-[180px] max-md:w-full">
                            <Search size={13} aria-hidden="true" className="shrink-0" />
                            <input
                                value={query}
                                onChange={e => setQuery(e.target.value)}
                                placeholder={t('compliance.dsr_search', 'Search number or e-mail…')}
                                className="min-w-0 flex-1 bg-transparent outline-none text-[12px] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]"
                                data-testid="dsr-search"
                                aria-label={t('compliance.dsr_search', 'Search number or e-mail…')}
                            />
                        </label>
                    </div>

                    <div className="min-h-0 overflow-y-auto flex flex-col gap-3">
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
                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)] text-[12px]" data-testid="dsr-intake-note">
                            <Globe size={14} aria-hidden="true" className="shrink-0" />
                            <span className="min-w-0">
                                {t('compliance.dsr_intake_note', 'Requests arrive through the public form (no account, rate-limited, linked from the privacy notice) or are recorded here by hand. The 30-day clock starts at receipt, not when work starts.')}
                            </span>
                            <a href={publicUrl} target="_blank" rel="noopener noreferrer"
                                className="ml-auto whitespace-nowrap inline-flex items-center gap-1 text-[var(--text-primary)] font-medium" data-testid="dsr-view-form">
                                {t('compliance.dsr_view_form', 'View form')}<ArrowUpRight size={12} aria-hidden="true" />
                            </a>
                        </div>
                    </div>
                </div>
                {inline && <div className="min-h-0 h-full">{drawer}</div>}
            </div>
            {!inline && drawer}
            <DsrCaptureModal open={captureOpen} onClose={() => setCaptureOpen(false)} onCapture={onCapture} busy={src.busyId === 'capture'} />
        </div>
    );
});

export default DsrPage;
