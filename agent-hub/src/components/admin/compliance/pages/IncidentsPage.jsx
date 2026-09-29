import React, { useEffect, useEffectEvent, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FilterPills from '../../../shared/FilterPills';
import EmptyState from '../../../shared/EmptyState';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { API, fetchJson, jsonInit } from '../data/api';
import IncidentsTable from './incidents/IncidentsTable';
import IncidentDrawer from './incidents/IncidentDrawer';
import IncidentCreateModal from './incidents/IncidentCreateModal';
import { kindsOfSection, matchesSection, nextClock } from './incidents/incidentClocks';

/**
 * IncidentsPage — the incident register (GDPR Art. 33/34 · NIS2 Art. 23 ·
 * DORA) AND the vulnerability register (CRA Art. 14). Which one it is follows
 * `section` (`incidents` → kind breach|security_incident; `vulnerabilities`
 * → kind vulnerability); the rows come from the ONE `GET /incidents` list and
 * are filtered client-side by kind.
 *
 * Coded against the hub's page props object with
 * `data.incidents = { incidents: array|null, busyId, create(body), update(id, body), notify(id), craReport(id, body), customerNotified(id), refresh() }`
 * and `data.vulnerabilities` of the same shape (the hub's second useIncidents,
 * scoped to kind=vulnerability); the vulnerability section reads that one when
 * it is present and falls back to `data.incidents` otherwise.
 * A missing hook function falls back to the legacy routes through
 * data/api.fetchJson; a 404 on the CRA routes (BE-1c not shipped yet) marks
 * CRA reporting unavailable — the buttons disable with a sentence.
 *
 * Header primary ("Record incident" / "Record vulnerability") lives in the
 * hub header: the page hands the handle up through `setHeaderActions`
 * (`onRecordIncident` / `onRecordVulnerability`) and the modal stays here. A
 * host that instead signals with `headerAction="create"` (+
 * `onHeaderActionHandled`) is served too; with neither, the page draws its
 * own primary in the toolbar so the register works standalone.
 */
export const HEADER_ACTION_CREATE = 'create';

const FILTERS = Object.freeze([
    Object.freeze({ id: 'all', tone: 'neutral', labelKey: 'compliance.inc_filter_all', fallback: 'All' }),
    Object.freeze({ id: 'open', tone: 'error', labelKey: 'compliance.inc_filter_open', fallback: 'Open' }),
    Object.freeze({ id: 'reported', tone: 'neutral', labelKey: 'compliance.inc_filter_reported', fallback: 'Reported' }),
    Object.freeze({ id: 'closed', tone: 'muted', labelKey: 'compliance.inc_filter_closed', fallback: 'Closed' }),
]);
const OPEN = new Set(['open', 'assessing', 'early_warning_sent']);
const REPORTED = new Set(['authority_notified', 'reported', 'subjects_notified']);

export function bucketOf(incident) {
    if (incident.status === 'closed') return 'closed';
    if (REPORTED.has(incident.status)) return 'reported';
    return OPEN.has(incident.status) ? 'open' : 'open';
}

/** Sort: running clocks first by due date, then reported, then closed (newest first). */
export function sortIncidents(rows) {
    const rank = { open: 0, reported: 1, closed: 2 };
    return rows.slice().sort((a, b) => {
        const ra = rank[bucketOf(a)], rb = rank[bucketOf(b)];
        if (ra !== rb) return ra - rb;
        if (ra === 0) {
            const da = nextClock(a)?.dueAt, db = nextClock(b)?.dueAt;
            if (da && db && da !== db) return new Date(da) - new Date(db);
        }
        return new Date(b.detected_at ?? b.created_at ?? 0) - new Date(a.detected_at ?? a.created_at ?? 0);
    });
}

const isNotFound = (e) => /^404\b/.test(String(e?.message || ''));

export default function IncidentsPage(props) {
    const { section, focusId, data = {}, isMobile = false, headerAction, onHeaderActionHandled, setHeaderActions } = props;
    const { t } = useTranslation();
    const sectionId = typeof section === 'string' ? section : (section?.id || 'incidents');
    const vuln = sectionId === 'vulnerabilities';
    const kind = kindsOfSection(sectionId)[0];
    // The hub loads the two registers through two hooks (`data.incidents`,
    // `data.vulnerabilities` — the same shape, the second scoped to
    // kind=vulnerability). Reading the section's own hook first means the page
    // works whether the host hands it the pair or, as data/pages.jsx does
    // today, aliases the right one onto `incidents`.
    const state = (vuln ? (data.vulnerabilities || data.incidents) : data.incidents) || {};
    const list = state.incidents;
    const loading = list === undefined || list === null;
    const failed = !loading && !Array.isArray(list);

    const [filter, setFilter] = useState('all');
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState(focusId != null ? Number(focusId) || null : null);
    const [showCreate, setShowCreate] = useState(false);
    const [craUnavailable, setCraUnavailable] = useState(false);
    const [seenFocusId, setSeenFocusId] = useState(focusId);
    if (seenFocusId !== focusId) {
        setSeenFocusId(focusId);
        if (focusId != null) setSelectedId(Number(focusId) || null);
    }
    const openCreateFromHeader = useEffectEvent(() => { setShowCreate(true); onHeaderActionHandled?.(); });
    useEffect(() => {
        if (headerAction === HEADER_ACTION_CREATE) openCreateFromHeader();
    }, [headerAction]);

    // The header's primary is drawn by the hub; the modal lives here, so the
    // hub gets the handle and loses it again on unmount (fe-1's contract —
    // HEADER_SPECS reads `ctx.onRecordIncident` / `ctx.onRecordVulnerability`).
    useEffect(() => {
        if (typeof setHeaderActions !== 'function') return undefined;
        const open = () => setShowCreate(true);
        setHeaderActions(vuln ? { onRecordVulnerability: open } : { onRecordIncident: open });
        return () => setHeaderActions({});
    }, [setHeaderActions, vuln]);

    const rows = useMemo(() => (Array.isArray(list) ? list.filter(i => matchesSection(i, sectionId)) : []), [list, sectionId]);
    const counts = useMemo(() => {
        if (!Array.isArray(list)) return null;
        const c = { all: rows.length, open: 0, reported: 0, closed: 0 };
        for (const r of rows) c[bucketOf(r)] += 1;
        return c;
    }, [list, rows]);
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sortIncidents(rows.filter(r => (filter === 'all' || bucketOf(r) === filter)
            && (!q || `inc-${r.id} vuln-${r.id} ${r.title || ''} ${(r.cve_ids || []).join(' ')}`.toLowerCase().includes(q))));
    }, [rows, filter, query]);
    const selected = useMemo(() => rows.find(r => r.id === selectedId) || null, [rows, selectedId]);

    // ── mutations: hook first, legacy route second ──
    const call = async (fn, url, init) => {
        if (typeof fn === 'function') return fn();
        const r = await fetchJson(url, init);
        await state.refresh?.();
        return r;
    };
    const create = (body) => call(state.create && (() => state.create(body)), `${API}/incidents`, jsonInit('POST', body));
    const update = (id, body) => call(state.update && (() => state.update(id, body)), `${API}/incidents/${encodeURIComponent(id)}`, jsonInit('PUT', body));
    const notify = (id) => call(state.notify && (() => state.notify(id)), `${API}/incidents/${encodeURIComponent(id)}/notify-recipients`, jsonInit('POST'));
    const cra = async (fn, url, body) => {
        try { return await call(fn, url, jsonInit('POST', body)); }
        catch (e) { if (isNotFound(e)) { setCraUnavailable(true); return null; } throw e; }
    };
    const craReport = (id, body) => cra(state.craReport && (() => state.craReport(id, body)), `${API}/incidents/${encodeURIComponent(id)}/cra-report`, body);
    const customerNotified = (id) => cra(state.customerNotified && (() => state.customerNotified(id)), `${API}/incidents/${encodeURIComponent(id)}/customer-notified`, undefined);

    const pillOptions = FILTERS.map(f => ({ value: f.id, label: t(f.labelKey, f.fallback), tone: f.tone, count: counts ? counts[f.id] : undefined }));
    const ownPrimary = typeof onHeaderActionHandled !== 'function' && typeof setHeaderActions !== 'function';

    const drawer = selected && (
        <IncidentDrawer
            incident={selected}
            busy={state.busyId === selected.id}
            onUpdate={update}
            onNotify={notify}
            onCraReport={craReport}
            onCustomerNotified={customerNotified}
            craUnavailable={craUnavailable}
            onClose={() => setSelectedId(null)}
            mode={isMobile ? 'modal' : 'inline'}
        />
    );

    return (
        <div className="relative h-full min-h-0 flex flex-col gap-3 p-3.5" data-testid={vuln ? 'vuln-page' : 'inc-page'} data-kind={kind}>
            <div className="flex flex-wrap items-center gap-2">
                <FilterPills value={filter} onChange={setFilter} options={pillOptions} ariaLabel={t('compliance.inc_col_status', 'Status')} testId="inc-filter" />
                <label className="ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] min-w-[160px]">
                    <Search size={12} aria-hidden="true" />
                    <input value={query} onChange={e => setQuery(e.target.value)}
                        placeholder={vuln ? t('compliance.vuln_search', 'Search CVE or title…') : t('compliance.inc_search', 'Search incident…')}
                        aria-label={vuln ? t('compliance.vuln_search', 'Search CVE or title…') : t('compliance.inc_search', 'Search incident…')}
                        className="bg-transparent outline-none flex-1 min-w-0 text-[var(--text-primary)]" data-testid="inc-search" />
                </label>
                {ownPrimary && (
                    <button type="button" onClick={() => setShowCreate(true)} style={PRIMARY_ACTION_STYLE}
                        className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5" data-testid="inc-record">
                        <Plus size={13} aria-hidden="true" /> {vuln ? t('compliance.vuln_record', 'Record vulnerability') : t('compliance.inc_record', 'Record incident')}
                    </button>
                )}
            </div>

            <div className="flex-1 min-h-0 flex gap-3 items-start">
                <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
                    {failed ? (
                        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="inc-failed">
                            {t('compliance.inc_read_failed', 'The incident register could not be read.')}
                        </div>
                    ) : (
                        <IncidentsTable
                            rows={visible}
                            selectedId={selectedId}
                            onSelect={(inc) => setSelectedId(prev => (prev === inc.id ? null : inc.id))}
                            loading={loading}
                            isMobile={isMobile}
                            empty={(
                                <EmptyState
                                    title={vuln ? t('compliance.vuln_empty_title', 'No vulnerabilities recorded') : t('compliance.inc_empty_title', 'No incidents recorded')}
                                    description={vuln
                                        ? t('compliance.vuln_empty', 'Record an actively exploited vulnerability here the moment you learn of it — the CRA early warning is due within 24 hours.')
                                        : t('compliance.inc_empty', 'No incidents recorded. If a breach is ever suspected, record it here immediately — the assessment itself is part of your accountability record.')}
                                />
                            )}
                        />
                    )}
                </div>
                {!isMobile && drawer}
            </div>
            {isMobile && drawer}

            <IncidentCreateModal
                open={showCreate}
                kind={kind}
                busy={state.busyId === 'create'}
                onCreate={create}
                onClose={() => setShowCreate(false)}
            />
        </div>
    );
}
