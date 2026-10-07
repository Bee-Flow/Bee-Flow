import { Download, Filter } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { actionLabel, actorName, detailOf, metaFor, subjectOf, when } from './accessAuditLabels';
import { Field, DateInput, UserSelect, ActionButton, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../shared/DataTable';
import EmptyState from '../../../shared/EmptyState';
import FilterPills from '../../../shared/FilterPills';
import Pager from '../../../shared/Pager';
import { TONES } from '../../../shared/statusTone';

/**
 * AccessAuditPage — the access & authentication trail (ISO/IEC 27001 A.8.15 and
 * A.5.16) on the shared table + pager.
 *
 * Sign-ins, refused sign-ins, access-control changes and changes to who can
 * reach an app, as they were recorded. This page is the only place in the
 * product an organisation can read them, which is the whole reason it exists:
 * a control nobody can produce evidence for does not survive being asked about.
 *
 * Filtering, paging and the export all go back to the SERVER — a client-side
 * filter over one page would quietly answer a different question than the one
 * the operator typed ("every failed sign-in this month" would mean "…on this
 * page"). The export is a plain `<a download>`, so the demo transport cannot
 * stand in for it; `dl()` returning null hides the button rather than offering
 * a 401.
 *
 * Redaction (BFSF-441 / the legacy test's rules): a refused sign-in NEVER
 * renders what was typed. The identifier fingerprint is a correlation handle,
 * shown as a short tag, never as a value to read.
 *
 * Names, not ids (accessAuditLabels): an event reads as words, the actor by
 * display name with the id in the tooltip, and a data-subject request as
 * "Request #2417", a link to that request.
 */

/** The subject cell: a request is a link to it, anything else is text. */
function Subject({ row, t, navigate, className = '' }) {
    const text = subjectOf(row, t);
    if (row.target_type === 'dsr_request' && row.target_id && typeof navigate === 'function') {
        return (
            <button type="button" onClick={() => navigate('dsr', row.target_id)} data-testid={`access-audit-subject-${row.id}`}
                className={`p-0 border-0 bg-transparent text-left underline decoration-[var(--border-default)] underline-offset-2 hover:decoration-current cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)] ${className}`.trim()}>
                {text}
            </button>
        );
    }
    return <span className={className}>{text}</span>;
}

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'when', label: 'compliance.aa_col_when', width: '190px' }),
    Object.freeze({ id: 'event', label: 'compliance.aa_col_event', width: '170px' }),
    Object.freeze({ id: 'subject', label: 'compliance.aa_col_subject', width: '1fr' }),
    Object.freeze({ id: 'actor', label: 'compliance.aa_col_actor', width: '150px', foldBelow: 900 }),
    Object.freeze({ id: 'detail', label: 'compliance.aa_col_detail', width: '1fr', foldBelow: 1180 }),
]);
const COLUMN_FALLBACKS = Object.freeze({ when: 'When', event: 'Event', subject: 'Subject', actor: 'By', detail: 'Detail' });

export default function AccessAuditPage({ data = {}, isMobile = false, exportsEnabled = true, dl, navigate = undefined }) {
    const { t, resolvedLocale } = useTranslation();
    const state = data.accessAudit || {};
    const orgUsers = data.orgUsers ?? null;
    const [showFilters, setShowFilters] = useState(false);

    const log = state.data;
    const filter = state.filter || {};
    const rows = log?.entries ?? null;
    const total = log?.total ?? null;
    const limit = log?.limit ?? 100;
    const offset = log?.offset ?? state.offset ?? 0;
    const failed = !!log?.error;
    const loading = !failed && (log === null || log === undefined || rows === null);

    const exportUrl = exportsEnabled && state.exportUrl && typeof dl === 'function' ? dl(state.exportUrl) : null;

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));

    // Built from what the log CONTAINS, so an action a later feature starts
    // writing appears here without anyone registering it, and one that never
    // happened in this organisation is not offered. An entry may be a bare
    // action string (no count) as well as { action, count }.
    const pillOptions = useMemo(() => ([
        { value: '', label: t('compliance.aa_filter_any', 'Any') },
        ...(Array.isArray(state.actions) ? state.actions : [])
            .map(a => (typeof a === 'string' ? { action: a } : a))
            .filter(a => a && typeof a.action === 'string' && a.action)
            .map(a => ({ value: a.action, label: actionLabel(a.action, t), count: a.count, tone: metaFor(a.action).tone })),
    ]), [state.actions, t]);

    // The account filter picks a member by name. An actor the roster does not
    // hold (a former member, the platform itself) is offered too while the log
    // on screen names it, and stays selectable while it is the active filter:
    // the free-text id field it replaced could filter on those as well.
    const actorOptions = useMemo(() => {
        const list = Array.isArray(orgUsers) ? orgUsers : [];
        const known = new Set(list.map(u => String(u.id)));
        const extra = [];
        const add = (id) => {
            if (!id || id === 'anonymous' || known.has(String(id))) return;
            known.add(String(id));
            extra.push(id === 'system' ? { id, displayName: t('compliance.aa_actor_system', 'System') } : { id });
        };
        for (const r of Array.isArray(rows) ? rows : []) add(r?.changed_by);
        add(filter.actor);
        return extra.length ? [...list, ...extra] : list;
    }, [orgUsers, rows, filter.actor, t]);

    const set = (patch) => state.setFilter?.({ ...filter, ...patch });
    const byLine = (r) => {
        const name = actorName(r, orgUsers, t);
        return name ? t('compliance.aa_by', 'by {name}', { name }) : null;
    };

    if (failed) {
        return (
            <div className="p-3.5" data-testid="access-audit-page">
                <ReadFailed testId="access-audit-failed">
                    <span className="font-semibold text-[var(--error-ink)] block">
                        {t('compliance.aa_error_title', 'The access log could not be read')}
                    </span>
                    <span className="text-[var(--text-secondary)]">{log.error}</span>
                </ReadFailed>
            </div>
        );
    }

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="access-audit-page"
            toolbar={(
                <>
                    <Intro testId="access-audit-intro">
                        {t('compliance.aa_intro',
                            'Every sign-in, every refused sign-in, and every change to who can reach something — as recorded, newest first. A refused sign-in never stores what was typed: an account name that matched nothing is shown as such.')}
                    </Intro>
                    <ActionButton icon={Filter} onClick={() => setShowFilters(v => !v)} aria-pressed={showFilters} data-testid="access-audit-filters-toggle">
                        {t('compliance.aa_filters', 'Filters')}
                    </ActionButton>
                    {exportUrl && (
                        <a
                            href={exportUrl}
                            download
                            className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[12px] font-medium text-[var(--text-primary)] no-underline"
                            data-testid="access-audit-export"
                        >
                            <Download size={13} aria-hidden="true" /> {t('compliance.aa_export', 'Export (JSON)')}
                        </a>
                    )}
                </>
            )}
        >
            <FilterPills
                value={filter.action || ''}
                onChange={(v) => set({ action: v || undefined })}
                options={pillOptions}
                ariaLabel={t('compliance.aa_filter_action', 'Event')}
                testId="access-audit-pill"
            />

            {state.exportError && (
                <ReadFailed testId="access-audit-export-error">{state.exportError}</ReadFailed>
            )}

            {showFilters && (
                <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-3 flex flex-wrap items-end gap-3" data-testid="access-audit-filters">
                    <Field label={t('compliance.aa_filter_since', 'From')} className="w-[160px]">
                        <DateInput value={filter.since || ''} onChange={(v) => set({ since: v || undefined })} data-testid="access-audit-since" />
                    </Field>
                    <Field label={t('compliance.aa_filter_until', 'To')} className="w-[160px]">
                        <DateInput value={filter.until || ''} onChange={(v) => set({ until: v || undefined })} data-testid="access-audit-until" />
                    </Field>
                    <Field label={t('compliance.aa_filter_actor', 'Account')} className="w-[220px]">
                        <UserSelect
                            value={filter.actor || ''}
                            orgUsers={actorOptions}
                            noneLabel={t('compliance.aa_filter_any', 'Any')}
                            onChange={(v) => set({ actor: v || undefined })}
                            data-testid="access-audit-actor"
                        />
                    </Field>
                    <ActionButton onClick={() => state.setFilter?.({})} data-testid="access-audit-clear">
                        {t('compliance.aa_filter_clear', 'Clear')}
                    </ActionButton>
                </div>
            )}

            <DataTable
                columns={columns}
                rows={Array.isArray(rows) ? rows : []}
                loading={loading}
                isMobile={isMobile}
                ariaLabel={t('compliance.rail_access_log', 'Access log')}
                testId="access-audit-table"
                empty={(
                    <EmptyState
                        title={t('compliance.aa_empty_title', 'No events in this range')}
                        description={t('compliance.aa_empty_sub', 'Sign-ins are recorded automatically. An empty list on a workspace people are using means the range is too narrow, or the events are not reaching the database.')}
                    />
                )}
                footer={(
                    <Pager
                        offset={offset}
                        limit={limit}
                        total={total}
                        onOffset={(next) => state.setOffset?.(next)}
                        testId="access-audit-pager"
                    />
                )}
                renderRow={(r, ctx) => {
                    const meta = metaFor(r.action);
                    const Icon = meta.icon;
                    const tone = TONES[meta.tone] ? meta.tone : 'neutral';
                    const by = byLine(r);
                    const detail = detailOf(r, t);
                    return (
                        <TableRow columns={ctx.columns} testId={`access-audit-row-${r.id}`}>
                            <TableCell column={ctx.columns[0]}>
                                <span className="whitespace-nowrap text-[var(--text-secondary)] tabular-nums">{when(r.created_at, resolvedLocale)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: TONES[tone]?.ink || 'var(--text-primary)' }}>
                                    <Icon size={13} aria-hidden="true" />
                                    {actionLabel(r.action, t)}
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <Subject row={r} t={t} navigate={navigate} className="text-[var(--text-primary)] [overflow-wrap:anywhere]" />
                                {/* The actor while the By column is folded. */}
                                {by && <div className="text-[11px] text-[var(--text-tertiary)] truncate"><span className={TABLE_FOLDED_ONLY[900]} title={r.changed_by}>{by}</span></div>}
                                {/* The detail (method, reason, address, same-name tag) while its own column is folded. */}
                                {detail !== '—' && <div className="text-[11px] text-[var(--text-tertiary)] [overflow-wrap:anywhere]"><span className={TABLE_FOLDED_ONLY[1180]} data-testid={`access-audit-folded-detail-${r.id}`}>{detail}</span></div>}
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <span className="truncate text-[var(--text-secondary)]" title={r.changed_by || undefined} data-testid={`access-audit-actor-${r.id}`}>{actorName(r, orgUsers, t) || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                <span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{detail}</span>
                            </TableCell>
                        </TableRow>
                    );
                }}
                renderCard={(r) => {
                    const by = byLine(r);
                    return (
                        <div className="flex flex-col gap-0.5 min-w-0" data-testid={`access-audit-card-${r.id}`}>
                            <span className="text-[11px] text-[var(--text-tertiary)] tabular-nums">{when(r.created_at, resolvedLocale)}</span>
                            <span className="text-xs font-semibold text-[var(--text-primary)]">{actionLabel(r.action, t)}</span>
                            <Subject row={r} t={t} navigate={navigate} className="text-[11px] text-[var(--text-secondary)] [overflow-wrap:anywhere]" />
                            {by && <span className="text-[11px] text-[var(--text-secondary)]" title={r.changed_by}>{by}</span>}
                            <span className="text-[11px] text-[var(--text-tertiary)]">{detailOf(r, t)}</span>
                        </div>
                    );
                }}
            />
        </RegisterLayout>
    );
}
