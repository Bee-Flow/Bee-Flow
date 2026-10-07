import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { Plus, Search, Sprout } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import FilterPills from '../../../shared/FilterPills';
import EmptyState from '../../../shared/EmptyState';
import Modal from '../../../shared/Modal';
import { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';
import { API, fetchJson, jsonInit } from '../data/api';
import RisksTable, { CATEGORIES, SCALE, RISK_STATUSES, scoreOf, isReviewOverdue, ownerName } from './risks/RisksTable';
import RiskDrawer from './risks/RiskDrawer';
import useDrawerMode from '../shared/useDrawerMode';

/**
 * RisksPage — the ISO 27001 6.1.2 / 6.1.3 risk register on the table pattern.
 *
 * Coded against the hub's page props object with
 * `data.risks = { risks: array|null, treatments, stats, busyId, create(fields), update(id, patch), addTreatment(riskId, fields), seed(), refresh() }`
 * (same handler names as the legacy page's onCreate/onUpdate/onAddTreatment/onSeed).
 * A missing hook function falls back to the legacy `/iso/risks` routes.
 *
 * Header: primary "Add risk" and secondary "Seed suggested risks". The page
 * hands both handles up through `setHeaderActions` (`onAddRisk`,
 * `onSeedRisks`) and keeps the modal; a host that signals with
 * `headerAction="create"` (+ `onHeaderActionHandled`) is served too. With
 * neither, the page draws both buttons in its own toolbar.
 *
 * The drawer goes where the register's width allows (useDrawerMode): beside
 * the table while the table keeps its room, over it behind a scrim at 1280
 * and 1024, a dialog on a phone.
 */
export const HEADER_ACTION_CREATE = 'create';

const FILTERS = Object.freeze([
    Object.freeze({ id: 'all', tone: 'neutral', labelKey: 'compliance.risk_filter_all', fallback: 'All' }),
    Object.freeze({ id: 'open', tone: 'error', labelKey: 'compliance.risk_status_open', fallback: 'Open' }),
    Object.freeze({ id: 'treating', tone: 'warning', labelKey: 'compliance.risk_status_treating', fallback: 'Treating' }),
    Object.freeze({ id: 'accepted', tone: 'neutral', labelKey: 'compliance.risk_status_accepted', fallback: 'Accepted' }),
    Object.freeze({ id: 'closed', tone: 'muted', labelKey: 'compliance.risk_status_closed', fallback: 'Closed' }),
    Object.freeze({ id: 'high', tone: 'error', labelKey: 'compliance.risk_filter_high', fallback: 'High (≥ 10)' }),
    Object.freeze({ id: 'overdue', tone: 'warning', labelKey: 'compliance.risk_filter_overdue', fallback: 'Review overdue' }),
]);

/**
 * The filter rule per pill. "High" is riskStore.getStats' rule (score >= 10,
 * closed risks drop out), so the pill counts what the header and the rail say.
 */
export function matchesFilter(r, filter) {
    switch (filter) {
        case 'all': return true;
        case 'high': return scoreOf(r) >= 10 && r.status !== 'closed';
        case 'overdue': return isReviewOverdue(r);
        default: return r.status === filter;
    }
}

/** Open first (highest score first), then treating, accepted, closed. */
export function sortRisks(rows) {
    const rank = { open: 0, treating: 1, accepted: 2, closed: 3 };
    return rows.slice().sort((a, b) => {
        const d = (rank[a.status] ?? 0) - (rank[b.status] ?? 0);
        if (d) return d;
        return scoreOf(b) - scoreOf(a) || (b.id - a.id);
    });
}

const EMPTY_DRAFT = Object.freeze({ title: '', description: '', category: 'confidentiality', likelihood: 3, impact: 3, owner_user_id: '' });

export default function RisksPage(props) {
    const { focusId, data = {}, isMobile = false, headerAction, onHeaderActionHandled, setHeaderActions } = props;
    const { t } = useTranslation();
    const state = data.risks || {};
    const list = state.risks;
    const loading = list === undefined || list === null;
    const failed = !loading && !Array.isArray(list);
    const orgUsers = data.orgUsers ?? null;
    const treatmentsByRisk = useMemo(() => {
        const m = new Map();
        for (const tr of Array.isArray(state.treatments) ? state.treatments : []) {
            if (!m.has(tr.risk_id)) m.set(tr.risk_id, []);
            m.get(tr.risk_id).push(tr);
        }
        return m;
    }, [state.treatments]);

    const [filter, setFilter] = useState('all');
    const [query, setQuery] = useState('');
    const [selectedId, setSelectedId] = useState(focusId != null ? Number(focusId) || null : null);
    const [showCreate, setShowCreate] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [seenFocusId, setSeenFocusId] = useState(focusId);
    if (seenFocusId !== focusId) {
        setSeenFocusId(focusId);
        if (focusId != null) setSelectedId(Number(focusId) || null);
    }
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });
    const openCreateFromHeader = useEffectEvent(() => { setShowCreate(true); onHeaderActionHandled?.(); });
    useEffect(() => {
        if (headerAction === HEADER_ACTION_CREATE) openCreateFromHeader();
    }, [headerAction]);

    const rows = Array.isArray(list) ? list : [];
    const counts = useMemo(() => {
        if (!Array.isArray(list)) return null;
        const c = {};
        for (const f of FILTERS) c[f.id] = rows.filter(r => matchesFilter(r, f.id)).length;
        return c;
    }, [list, rows]);
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sortRisks(rows.filter(r => matchesFilter(r, filter)
            && (!q || `r-${r.id} ${r.title || ''} ${r.description || ''} ${ownerName(orgUsers, r.owner_user_id) || ''}`.toLowerCase().includes(q))));
    }, [rows, filter, query, orgUsers]);
    const selected = useMemo(() => rows.find(r => r.id === selectedId) || null, [rows, selectedId]);

    const call = async (fn, url, init) => {
        if (typeof fn === 'function') return fn();
        const r = await fetchJson(url, init);
        await state.refresh?.();
        return r;
    };
    const create = (fields) => call(state.create && (() => state.create(fields)), `${API}/iso/risks`, jsonInit('POST', fields));
    const update = (id, patch) => call(state.update && (() => state.update(id, patch)), `${API}/iso/risks/${encodeURIComponent(id)}`, jsonInit('PUT', patch));
    const addTreatment = (riskId, fields) => call(state.addTreatment && (() => state.addTreatment(riskId, fields)), `${API}/iso/risks/${encodeURIComponent(riskId)}/treatments`, jsonInit('POST', fields));
    const seed = () => call(state.seed && (() => state.seed()), `${API}/iso/risks/seed`, jsonInit('POST'));

    // The header draws "Add risk" and "Seed suggested risks"; the modal and
    // the seed call live here. The handles go up once (the seed reference is
    // read through a ref, so re-registering never chases a new closure).
    const seedRef = useRef(seed);
    seedRef.current = seed;
    useEffect(() => {
        if (typeof setHeaderActions !== 'function') return undefined;
        setHeaderActions({ onAddRisk: () => setShowCreate(true), onSeedRisks: () => seedRef.current() });
        return () => setHeaderActions({});
    }, [setHeaderActions]);

    const submitCreate = async () => {
        if (!draft.title.trim()) return;
        await create(createFields(draft));
        setDraft(EMPTY_DRAFT);
        setShowCreate(false);
    };

    const ownHeader = typeof onHeaderActionHandled !== 'function' && typeof setHeaderActions !== 'function';
    const pillOptions = FILTERS.map(f => ({ value: f.id, label: t(f.labelKey, f.fallback), tone: f.tone, count: counts ? counts[f.id] : undefined }));

    const drawer = selected && (
        <RiskDrawer
            risk={selected}
            treatments={treatmentsByRisk.get(selected.id) || []}
            orgUsers={orgUsers}
            busy={state.busyId === selected.id}
            onUpdate={update}
            onAddTreatment={addTreatment}
            onClose={() => setSelectedId(null)}
            mode={drawerMode}
        />
    );
    const inline = drawerMode === 'inline';

    return (
        <div className="relative h-full min-h-0 flex flex-col gap-3 p-3.5" data-testid="risk-page" data-drawer-mode={drawer ? drawerMode : undefined}>
            <div className="flex flex-wrap items-center gap-2">
                <FilterPills value={filter} onChange={setFilter} options={pillOptions} ariaLabel={t('compliance.risk_col_status', 'Status')} testId="risk-filter" />
                <label className="ml-auto inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-xs text-[var(--text-secondary)] min-w-[160px]">
                    <Search size={12} aria-hidden="true" />
                    <input value={query} onChange={e => setQuery(e.target.value)} placeholder={t('compliance.risk_search', 'Search risk…')} aria-label={t('compliance.risk_search', 'Search risk…')}
                        className="bg-transparent outline-none flex-1 min-w-0 text-[var(--text-primary)]" data-testid="risk-search" />
                </label>
                {ownHeader && (
                    <>
                        <button type="button" onClick={seed} disabled={!!state.busyId} title={t('compliance.risk_seed_hint', 'Adds common AI-workspace risk scenarios that are not in your register yet — never duplicates and never overwrites entries you already edited.')}
                            className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] inline-flex items-center gap-1.5 disabled:opacity-50" data-testid="risk-seed">
                            <Sprout size={13} aria-hidden="true" /> {t('compliance.risk_seed_button', 'Seed suggested risks')}
                        </button>
                        <button type="button" onClick={() => setShowCreate(true)} style={PRIMARY_ACTION_STYLE}
                            className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5" data-testid="risk-add">
                            <Plus size={13} aria-hidden="true" /> {t('compliance.risk_add', 'Add risk')}
                        </button>
                    </>
                )}
            </div>

            <div ref={frameRef} className="flex-1 min-h-0 flex gap-3 items-start">
                <div className="flex-1 min-w-0 min-h-0 overflow-y-auto">
                    {failed ? (
                        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3 text-xs text-[var(--text-tertiary)]" data-testid="risk-failed">
                            {t('compliance.risk_read_failed', 'The risk register could not be read.')}
                        </div>
                    ) : (
                        <RisksTable
                            rows={visible}
                            treatmentsByRisk={treatmentsByRisk}
                            orgUsers={orgUsers}
                            selectedId={selectedId}
                            onSelect={(r) => setSelectedId(prev => (prev === r.id ? null : r.id))}
                            loading={loading}
                            isMobile={isMobile}
                            empty={(
                                <EmptyState
                                    title={t('compliance.risk_empty_title', 'No risks in the register yet')}
                                    description={t('compliance.risk_empty', 'No risks in the register yet. Seed the suggested scenarios or add your first risk — clause 6.1.2 expects a maintained register.')}
                                />
                            )}
                        />
                    )}
                </div>
                {inline && drawer}
            </div>
            {!inline && drawer}

            <Modal
                open={showCreate}
                onClose={() => setShowCreate(false)}
                size="md"
                title={t('compliance.risk_add', 'Add risk')}
                description={t('compliance.risk_create_hint', 'Score likelihood × impact on 1–5; the treatment decision comes after, in the drawer.')}
                footer={(
                    <div className="flex items-center justify-end gap-2">
                        <button type="button" onClick={() => setShowCreate(false)} className="h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-secondary)]">{t('common.cancel', 'Cancel')}</button>
                        <button type="button" disabled={!!state.busyId || !draft.title.trim()} onClick={submitCreate} style={PRIMARY_ACTION_STYLE}
                            className="h-8 px-3 rounded-[10px] text-[12px] font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed" data-testid="risk-create-submit">
                            <Plus size={13} aria-hidden="true" /> {t('compliance.risk_create', 'Add to register')}
                        </button>
                    </div>
                )}
            >
                <div className="flex flex-col gap-3" data-testid="risk-create">
                    <Field label={t('compliance.risk_f_title', 'Title')}>
                        <input autoFocus value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))} className={INPUT} data-testid="risk-create-title" />
                    </Field>
                    <Field label={t('compliance.risk_f_desc', 'Description')}>
                        <textarea rows={3} value={draft.description} onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} placeholder={t('compliance.risk_f_desc_ph', 'What could go wrong, and what would the consequence be?')} className={`${INPUT} resize-y`} data-testid="risk-create-description" />
                    </Field>
                    <div className="grid grid-cols-3 gap-3">
                        <Field label={t('compliance.risk_f_category', 'Category')}>
                            <select value={draft.category} onChange={e => setDraft(d => ({ ...d, category: e.target.value }))} className={INPUT} data-testid="risk-create-category">
                                {CATEGORIES.map(c => <option key={c} value={c}>{t(`compliance.risk_cat_${c}`, c)}</option>)}
                            </select>
                        </Field>
                        <Field label={t('compliance.risk_f_likelihood', 'Likelihood (1–5)')}>
                            <select value={draft.likelihood} onChange={e => setDraft(d => ({ ...d, likelihood: e.target.value }))} className={INPUT} data-testid="risk-create-likelihood">
                                {SCALE.map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                        </Field>
                        <Field label={t('compliance.risk_f_impact', 'Impact (1–5)')}>
                            <select value={draft.impact} onChange={e => setDraft(d => ({ ...d, impact: e.target.value }))} className={INPUT} data-testid="risk-create-impact">
                                {SCALE.map(n => <option key={n} value={n}>{n}</option>)}
                            </select>
                        </Field>
                    </div>
                    <Field label={t('compliance.risk_f_owner', 'Owner')}>
                        <select value={draft.owner_user_id} onChange={e => setDraft(d => ({ ...d, owner_user_id: e.target.value }))} className={INPUT} data-testid="risk-create-owner">
                            <option value="">{t('compliance.risk_owner_none', 'No owner')}</option>
                            {(Array.isArray(orgUsers) ? orgUsers : []).map(u => <option key={u.id} value={u.id}>{u.displayName}</option>)}
                        </select>
                    </Field>
                </div>
            </Modal>
        </div>
    );
}

/** POST /iso/risks body — the legacy page's allow-list. */
export function createFields(draft) {
    return {
        title: String(draft.title || '').trim(),
        description: String(draft.description || '').trim() || undefined,
        category: draft.category,
        likelihood: Number(draft.likelihood),
        impact: Number(draft.impact),
        owner_user_id: draft.owner_user_id || undefined,
    };
}

export { RISK_STATUSES };

const INPUT = 'w-full rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]';

function Field({ label, children }) {
    return (
        <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">{label}</span>
            {children}
        </label>
    );
}
