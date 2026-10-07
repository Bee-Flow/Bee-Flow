import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FilterPills from '../../../shared/FilterPills';
import Pager from '../../../shared/Pager';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import { API, fetchJson, asArray, jsonInit } from '../data/api';
import { useDateFormat } from '../shared/formatDates';
import useDrawerMode from '../shared/useDrawerMode';
import SoaTable, { DecisionPill } from './soa/SoaTable';
import SoaDrawer from './soa/SoaDrawer';
import {
    THEMES, DECISION_FILTERS, PAGE_LIMIT,
    countByDecision, countByTheme, filterControls, indexChecks, pageSlice, decisionOf,
} from './soa/soaThemes';

/**
 * SoaPage — Statement of Applicability register (artboard 1d).
 *
 * Coded against the hub's page props object (PLAN-FRONTEND C2/C3):
 *   { section, tab, onTab, navigate, focusId, data: { core, orgUsers, soa }, isMobile }
 * with `data.soa = { soa: GET /iso/soa body | null, busyRef, seed(), update(ref, patch), refresh() }`.
 * When `update` is missing at runtime the page PUTs `/iso/soa/:ref` itself
 * through data/api.fetchJson (the legacy route) and refreshes.
 *
 * Tabs: `controls` (the table + drawer) · `history` (GET /iso/soa/history —
 * a failed read is its own state, never an empty list). The SoA PDF and the
 * evidence bundle are in the header's Export menu (registerSpecs.soa) with
 * the explanation above them; an old `?tab=export` link lands on `controls`
 * (sections.js legacyTabs), and so does any tab this page does not know.
 *
 * The toolbar is one row: the decision pills, the theme as a compact select
 * ("All themes · 93"), the search. The drawer goes where the width allows
 * (useDrawerMode).
 */

const DECISION_PILL = Object.freeze({
    all: { tone: 'neutral', labelKey: 'compliance.soa_filter_all', fallback: 'All' },
    todo: { tone: 'warning', labelKey: 'compliance.soa_decision_todo', fallback: 'To review' },
    reviewed: { tone: 'neutral', labelKey: 'compliance.soa_decision_reviewed', fallback: 'Reviewed' },
    approved: { tone: 'success', labelKey: 'compliance.soa_decision_approved', fallback: 'Approved' },
    excluded: { tone: 'muted', labelKey: 'compliance.soa_decision_excluded', fallback: 'Excluded' },
});

export default function SoaPage(props) {
    const { tab = 'controls', navigate, focusId, data = {}, isMobile = false } = props;
    const { t } = useTranslation();
    const soaState = data.soa || {};
    const body = soaState.soa;
    const checksById = useMemo(() => indexChecks(data.core?.checks), [data.core?.checks]);
    const orgUsers = data.orgUsers ?? null;

    const controls = Array.isArray(body?.controls) ? body.controls : null;
    const loading = body === null || body === undefined;
    const failed = !loading && (controls === null || !!body?.error);

    const [decision, setDecision] = useState('all');
    const [theme, setTheme] = useState('all');
    const [query, setQuery] = useState('');
    const [offset, setOffset] = useState(0);
    const [selectedRef, setSelectedRef] = useState(focusId || null);
    useEffect(() => { if (focusId) setSelectedRef(String(focusId)); }, [focusId]);
    useEffect(() => { setOffset(0); }, [decision, theme, query]);
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });

    const decisionCounts = useMemo(() => (controls ? countByDecision(controls) : null), [controls]);
    const themeCounts = useMemo(() => (controls ? countByTheme(controls) : null), [controls]);
    const filtered = useMemo(() => filterControls(controls, { decision, theme, query, t }), [controls, decision, theme, query, t]);
    const page = useMemo(() => pageSlice(filtered, offset, PAGE_LIMIT), [filtered, offset]);
    const selected = useMemo(() => (controls || []).find(c => c.ref === selectedRef) || null, [controls, selectedRef]);

    const update = async (ref, patch) => {
        if (typeof soaState.update === 'function') return soaState.update(ref, patch);
        await fetchJson(`${API}/iso/soa/${encodeURIComponent(ref)}`, jsonInit('PUT', patch));
        await soaState.refresh?.();
    };

    if (tab === 'history') return <SoaHistoryTab orgUsers={orgUsers} t={t} isMobile={isMobile} />;

    const pillOptions = DECISION_FILTERS.map(id => ({
        value: id,
        label: t(DECISION_PILL[id].labelKey, DECISION_PILL[id].fallback),
        tone: DECISION_PILL[id].tone,
        count: decisionCounts ? decisionCounts[id] : undefined,
    }));
    const withCount = (label, n) => (typeof n === 'number' ? `${label} · ${n}` : label);
    const themeOptions = [
        { value: 'all', label: withCount(t('compliance.soa_theme_all', 'All themes'), themeCounts?.all) },
        ...THEMES.map(th => ({ value: th.id, label: withCount(t(th.labelKey, th.fallback), themeCounts ? themeCounts[th.id] : undefined) })),
    ];

    const drawer = selected && (
        <SoaDrawer
            control={selected}
            checksById={checksById}
            orgUsers={orgUsers}
            busy={soaState.busyRef === selected.ref}
            onSave={async (ref, patch) => { await update(ref, patch); }}
            onClose={() => setSelectedRef(null)}
            navigate={navigate}
            mode={drawerMode}
        />
    );
    const inline = drawerMode === 'inline';

    return (
        <div className="relative h-full min-h-0 flex flex-col gap-3 p-3.5" data-testid="soa-page" data-drawer-mode={drawer ? drawerMode : undefined}>
            <div className="flex flex-wrap items-center gap-2">
                <FilterPills value={decision} onChange={setDecision} options={pillOptions} ariaLabel={t('compliance.soa_col_status', 'Decision')} testId="soa-decision" />
                <span className="relative inline-flex items-center">
                    <select
                        value={theme}
                        onChange={e => setTheme(e.target.value)}
                        aria-label={t('compliance.soa_theme_label', 'Theme')}
                        className="appearance-none h-8 pl-2.5 pr-7 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs font-medium text-[var(--text-primary)] cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                        data-testid="soa-theme"
                    >
                        {themeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                    <ChevronDown size={13} aria-hidden="true" className="pointer-events-none absolute right-2 text-[var(--text-tertiary)]" />
                </span>
                <label className="ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] min-w-[160px]">
                    <Search size={12} aria-hidden="true" />
                    <input
                        value={query}
                        onChange={e => setQuery(e.target.value)}
                        placeholder={t('compliance.soa_search', 'Search control…')}
                        aria-label={t('compliance.soa_search', 'Search control…')}
                        className="bg-transparent outline-none flex-1 min-w-0 text-[var(--text-primary)]"
                        data-testid="soa-search"
                    />
                </label>
            </div>

            <div ref={frameRef} className="flex-1 min-h-0 flex gap-3 items-start">
                <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
                    {failed ? (
                        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="soa-failed">
                            {t('compliance.soa_read_failed', 'The Statement of Applicability could not be read.')}
                        </div>
                    ) : (
                        <SoaTable
                            rows={page.rows}
                            checksById={checksById}
                            orgUsers={orgUsers}
                            selectedRef={selectedRef}
                            onSelect={(c) => setSelectedRef(prev => (prev === c.ref ? null : c.ref))}
                            loading={loading}
                            isMobile={isMobile}
                            footer={<Pager offset={page.offset} limit={page.limit} total={page.total} onOffset={setOffset} testId="soa-pager" />}
                            empty={(
                                <EmptyState
                                    title={t('compliance.soa_empty_title', 'No controls match')}
                                    description={t('compliance.soa_empty_desc', 'Change the filter or the search to see rows again.')}
                                />
                            )}
                        />
                    )}
                </div>
                {inline && drawer}
            </div>
            {!inline && drawer}
        </div>
    );
}

/* ───────────────────────── history ───────────────────────── */

/** `GET /iso/soa/history` rows — tolerated shapes: `{ control_ref|ref, changed_at|updated_at|at, changed_by|updated_by|by, status, applicable, field?, from?, to? }`. */
export function normaliseHistoryRow(row, i) {
    if (!row || typeof row !== 'object') return null;
    const ref = row.control_ref ?? row.ref ?? null;
    const at = row.changed_at ?? row.updated_at ?? row.at ?? null;
    const by = row.changed_by ?? row.updated_by ?? row.by ?? null;
    const decision = row.applicable === false ? 'excluded' : (row.status ?? null);
    return { id: row.id ?? `${ref}-${at}-${i}`, ref, at, by, decision, field: row.field ?? null, from: row.from ?? null, to: row.to ?? null, note: row.note ?? null };
}

function SoaHistoryTab({ orgUsers, t, isMobile }) {
    const { formatStamp } = useDateFormat();
    const stamp = (value) => formatStamp(value) || '—';
    const [rows, setRows] = useState(undefined); // undefined = loading · null = failed · [] = nothing yet
    useEffect(() => {
        let alive = true;
        fetchJson(`${API}/iso/soa/history`)
            .then(b => { if (alive) setRows(asArray(Array.isArray(b) ? b : b?.rows ?? b?.history)); })
            .catch(() => { if (alive) setRows(null); });
        return () => { alive = false; };
    }, []);

    const columns = [
        { id: 'at', width: '132px', label: t('compliance.soa_hist_col_when', 'When') },
        { id: 'ref', width: '58px', label: t('compliance.soa_col_control', 'Control') },
        { id: 'change', width: '1fr', label: t('compliance.soa_hist_col_change', 'Change') },
        { id: 'by', width: '110px', label: t('compliance.soa_hist_col_by', 'By') },
    ];
    const list = Array.isArray(rows) ? rows.map(normaliseHistoryRow).filter(Boolean) : [];
    const who = (id) => (Array.isArray(orgUsers) ? orgUsers.find(u => u.id === id)?.displayName : null) || (id ? '—' : '—');

    return (
        <div className="h-full min-h-0 overflow-y-auto p-3.5" data-testid="soa-history">
            {rows === null ? (
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="soa-history-failed">
                    {t('compliance.soa_history_unavailable', 'The change log could not be read.')}
                </div>
            ) : (
                <DataTable
                    columns={columns}
                    rows={list}
                    loading={rows === undefined}
                    isMobile={isMobile}
                    rowKey={(r) => r.id}
                    ariaLabel={t('compliance.tab_soa_history', 'History')}
                    testId="soa-history-table"
                    empty={<EmptyState title={t('compliance.soa_history_empty', 'No changes recorded yet')} description={t('compliance.soa_history_empty_desc', 'Every saved decision lands here with who and when.')} />}
                    renderCard={(r) => (
                        <div className="w-full min-w-0 flex flex-col gap-1" data-testid={`soa-history-card-${r.id}`}>
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="font-mono text-[11px] text-[var(--text-secondary)]">{r.ref || '—'}</span>
                                {r.decision && <DecisionPill decision={decisionOf({ entry: { status: r.decision, applicable: r.decision !== 'excluded' } })} />}
                            </div>
                            <span className="truncate text-xs text-[var(--text-primary)]">
                                {r.field ? `${r.field}${r.to != null ? `: ${r.to}` : ''}` : (r.note || '')}
                            </span>
                            <span className="text-[11px] text-[var(--text-tertiary)] truncate">{stamp(r.at)} · {who(r.by)}</span>
                        </div>
                    )}
                    renderRow={(r, ctx) => (
                        <TableRow key={r.id} columns={ctx.columns} testId={`soa-history-row-${r.id}`}>
                            <TableCell column={ctx.columns[0]} className="text-[11px] text-[var(--text-secondary)] whitespace-nowrap">{stamp(r.at)}</TableCell>
                            <TableCell column={ctx.columns[1]} className="font-mono text-[11px]">{r.ref || '—'}</TableCell>
                            <TableCell column={ctx.columns[2]} className="min-w-0 flex items-center gap-2">
                                {r.decision && <DecisionPill decision={decisionOf({ entry: { status: r.decision, applicable: r.decision !== 'excluded' } })} />}
                                <span className="truncate text-[11px] text-[var(--text-secondary)]">
                                    {r.field ? `${r.field}${r.to != null ? `: ${r.to}` : ''}` : (r.note || '')}
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[3]} className="truncate text-[11px]">{who(r.by)}</TableCell>
                        </TableRow>
                    )}
                />
            )}
        </div>
    );
}
