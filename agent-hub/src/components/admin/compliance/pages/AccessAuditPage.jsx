import React, { useMemo, useState } from 'react';
import { ScrollText, Download, Filter, LogIn, LogOut, ShieldOff, Globe, Users } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import FilterPills from '../../../shared/FilterPills';
import Pager from '../../../shared/Pager';
import EmptyState from '../../../shared/EmptyState';
import { TONES } from '../../../shared/statusTone';
import { Field, TextInput, DateInput, ActionButton, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';

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
 */

/** Actions the log writes, so the list reads as events rather than ids. */
export const ACTION_META = {
    login_succeeded: { icon: LogIn, tone: 'success', key: 'compliance.aa_action_login_ok', en: 'Signed in' },
    login_failed: { icon: LogOut, tone: 'warning', key: 'compliance.aa_action_login_fail', en: 'Sign-in refused' },
    login_blocked: { icon: ShieldOff, tone: 'error', key: 'compliance.aa_action_login_blocked', en: 'Sign-in blocked' },
    studio_app_published: { icon: Users, tone: 'neutral', key: 'compliance.aa_action_app_published', en: 'App published' },
    studio_app_unpublished: { icon: Users, tone: 'neutral', key: 'compliance.aa_action_app_unpublished', en: 'App unpublished' },
    studio_app_public_page_created: { icon: Globe, tone: 'error', key: 'compliance.aa_action_public_page_created', en: 'Public URL created' },
    studio_app_public_page_revoked: { icon: Globe, tone: 'neutral', key: 'compliance.aa_action_public_page_revoked', en: 'Public URL revoked' },
};

export function metaFor(action) {
    return ACTION_META[action] || { icon: ScrollText, tone: 'neutral', key: null, en: action };
}

/** Local time, seconds included — a minute is not enough to order a burst of failures. */
export function when(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

/**
 * What a row is ABOUT, in one line — never the raw payload, and never the
 * fingerprint: an account name that matched nothing is shown as exactly that.
 */
export function subjectOf(row, t) {
    const d = row.new_values || {};
    if (row.target_type === 'login_identifier') {
        return t('compliance.aa_subject_unknown_account', 'an account name that matched nothing');
    }
    if (row.target_type === 'studio_app') {
        return d.appName || row.target_id;
    }
    return row.target_id;
}

/** The detail line, from an explicit allow-list of payload keys. */
export function detailOf(row, t) {
    const d = row.new_values || {};
    return [
        d.method,
        d.reason,
        d.audience,
        d.ip,
        d.identifierFingerprint
            ? t('compliance.aa_same_name_tag', 'same-name tag {tag}', { tag: String(d.identifierFingerprint).slice(-6) })
            : null,
    ].filter(Boolean).join(' · ') || '—';
}

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'when', label: 'compliance.aa_col_when', width: '190px' }),
    Object.freeze({ id: 'event', label: 'compliance.aa_col_event', width: '170px' }),
    Object.freeze({ id: 'subject', label: 'compliance.aa_col_subject', width: '1fr' }),
    Object.freeze({ id: 'actor', label: 'compliance.aa_col_actor', width: '150px', foldBelow: 1180 }),
    Object.freeze({ id: 'detail', label: 'compliance.aa_col_detail', width: '1fr', foldBelow: 1180 }),
]);
const COLUMN_FALLBACKS = Object.freeze({ when: 'When', event: 'Event', subject: 'Subject', actor: 'By', detail: 'Detail' });

export default function AccessAuditPage({ data = {}, isMobile = false, exportsEnabled = true, dl }) {
    const { t } = useTranslation();
    const state = data.accessAudit || {};
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
    // happened in this organisation is not offered.
    const pillOptions = useMemo(() => ([
        { value: '', label: t('compliance.aa_filter_any', 'Any') },
        ...(Array.isArray(state.actions) ? state.actions : []).map(a => {
            const meta = metaFor(a.action);
            return {
                value: a.action,
                label: meta.key ? t(meta.key, meta.en) : a.action,
                count: a.count,
                tone: meta.tone,
            };
        }),
    ]), [state.actions, t]);

    const set = (patch) => state.setFilter?.({ ...filter, ...patch });

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
                    <Field label={t('compliance.aa_filter_actor', 'Account')} className="w-[200px]">
                        <TextInput
                            value={filter.actor || ''}
                            onChange={(v) => set({ actor: v || undefined })}
                            placeholder={t('compliance.aa_filter_actor_ph', 'user id')}
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
                    return (
                        <TableRow columns={ctx.columns} testId={`access-audit-row-${r.id}`}>
                            <TableCell column={ctx.columns[0]}>
                                <span className="whitespace-nowrap text-[var(--text-secondary)]">{when(r.created_at)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="inline-flex items-center gap-1.5 font-medium" style={{ color: TONES[tone]?.ink || 'var(--text-primary)' }}>
                                    <Icon size={13} aria-hidden="true" />
                                    {meta.key ? t(meta.key, meta.en) : r.action}
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                <span className="text-[var(--text-primary)] [overflow-wrap:anywhere]">{subjectOf(r, t)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <span className="truncate text-[var(--text-secondary)]">{r.changed_by || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                <span className="text-[var(--text-secondary)] [overflow-wrap:anywhere]">{detailOf(r, t)}</span>
                            </TableCell>
                        </TableRow>
                    );
                }}
                renderCard={(r) => (
                    <div className="flex flex-col gap-0.5 px-3.5 py-2.5" data-testid={`access-audit-card-${r.id}`}>
                        <span className="text-[11px] text-[var(--text-tertiary)]">{when(r.created_at)}</span>
                        <span className="text-xs font-semibold text-[var(--text-primary)]">{metaFor(r.action).key ? t(metaFor(r.action).key, metaFor(r.action).en) : r.action}</span>
                        <span className="text-[11px] text-[var(--text-secondary)]">{subjectOf(r, t)}</span>
                        <span className="text-[11px] text-[var(--text-tertiary)]">{detailOf(r, t)}</span>
                    </div>
                )}
            />
        </RegisterLayout>
    );
}
