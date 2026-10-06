import React, { useMemo, useState } from 'react';
import { Sprout, AlertTriangle, Users } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import { userName, fmtDate, ActionButton, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import PolicyDrawer from './policies/PolicyDrawer';

/**
 * PoliciesPage — the ISMS document register (ISO 27001 A.5.1 / clause 7.5) on
 * the shared table + drawer pattern.
 *
 * `data.policies = { docs, busySlug, refresh, seed(), loadDoc(slug),
 * save(slug, patch), publish(slug) }` — the legacy page's onSeed/onLoadDoc/
 * onSave/onPublish under the hub's names. `docs` is
 * `{ documents: [], missing_seeds: [] }`; `null` is "not read yet" and a
 * non-object is a failed read, which is its own state, never an empty list.
 */

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'slug', label: 'compliance.policies_col_slug', width: '150px' }),
    Object.freeze({ id: 'title', label: 'compliance.policies_col_title', width: '1fr' }),
    Object.freeze({ id: 'acks', label: 'compliance.policies_col_acks', width: '110px' }),
    Object.freeze({ id: 'status', label: 'compliance.policies_col_status', width: '130px' }),
    Object.freeze({ id: 'owner', label: 'compliance.policies_col_owner', width: '150px', foldBelow: 1180 }),
    Object.freeze({ id: 'review', label: 'compliance.policies_col_review', width: '130px', foldBelow: 1180 }),
]);

const COLUMN_FALLBACKS = Object.freeze({
    slug: 'Document', title: 'Title', acks: 'Acknowledged', status: 'Status', owner: 'Owner', review: 'Review due',
});

export function isReviewOverdue(doc, now = Date.now()) {
    if (!doc?.review_due_at) return false;
    const ms = new Date(doc.review_due_at).getTime();
    return !Number.isNaN(ms) && ms < now;
}

export default function PoliciesPage({ data = {}, isMobile = false, focusId = null }) {
    const { t, resolvedLocale } = useTranslation();
    const state = data.policies || {};
    const docs = state.docs;
    const orgUsers = data.orgUsers ?? null;

    const loading = docs === null || docs === undefined;
    const failed = !loading && (typeof docs !== 'object' || !Array.isArray(docs.documents));
    const documents = !loading && !failed ? docs.documents : [];
    const missing = !loading && !failed && Array.isArray(docs.missing_seeds) ? docs.missing_seeds : [];
    /** A member total we do not know renders nothing — never a 0 denominator. */
    const memberTotal = Array.isArray(orgUsers) ? orgUsers.length : null;

    const [openSlug, setOpenSlug] = useState(focusId ? String(focusId) : null);
    const selected = useMemo(() => documents.find(d => d.slug === openSlug) || null, [documents, openSlug]);

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));

    const drawer = selected && (
        <PolicyDrawer
            doc={selected}
            orgUsers={orgUsers}
            busy={state.busySlug === selected.slug}
            onLoadDoc={state.loadDoc}
            onSave={state.save}
            onPublish={state.publish}
            onClose={() => setOpenSlug(null)}
            mode={isMobile ? 'modal' : 'inline'}
        />
    );

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="policies-page"
            drawer={drawer}
            toolbar={(
                <>
                    <Intro testId="policies-intro">
                        {t('compliance.policies_intro', 'Your ISMS policies. A published version is frozen and sha256-stamped; members acknowledge that exact version.')}
                    </Intro>
                    {missing.length > 0 && (
                        <ActionButton
                            variant="primary"
                            icon={Sprout}
                            disabled={!!state.busySlug}
                            onClick={() => state.seed?.()}
                            data-testid="policies-seed"
                        >
                            {t('compliance.policies_seed_count', 'Add the {count} missing templates', { count: missing.length })}
                        </ActionButton>
                    )}
                </>
            )}
        >
            {failed ? (
                <ReadFailed testId="policies-failed">
                    {t('compliance.policies_read_failed_list', 'The policy register could not be read.')}
                </ReadFailed>
            ) : (
                <DataTable
                    columns={columns}
                    rows={documents}
                    rowKey={(d) => d.slug}
                    loading={loading}
                    isMobile={isMobile}
                    ariaLabel={t('compliance.rail_policies', 'Policies')}
                    testId="policies-table"
                    empty={(
                        <EmptyState
                            title={t('compliance.policies_empty_title', 'No policy documents yet')}
                            description={t('compliance.policies_empty', 'Seed the ISMS templates and adjust them to how you actually work — clause 7.5 expects documented information.')}
                        />
                    )}
                    renderRow={(d, ctx) => {
                        const published = d.status === 'published';
                        const overdue = isReviewOverdue(d);
                        return (
                            <TableRow
                                columns={ctx.columns}
                                accent={overdue ? 'error' : (published ? 'success' : 'warning')}
                                selected={openSlug === d.slug}
                                onClick={() => setOpenSlug(prev => (prev === d.slug ? null : d.slug))}
                                testId={`policies-row-${d.slug}`}
                            >
                                <TableCell column={ctx.columns[0]}>
                                    <span className="font-mono text-[11px] text-[var(--text-secondary)] truncate">{d.slug}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[1]}>
                                    <span className="flex flex-col min-w-0">
                                        <span className="font-semibold text-[var(--text-primary)] truncate">{d.title}</span>
                                        <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                            {published
                                                ? t('compliance.policies_published_v', 'Published v{version}', { version: d.current_version })
                                                : t('compliance.policies_draft', 'Draft')}
                                            {!d.edited && (
                                                <span className="ml-1.5 inline-flex items-center gap-1 text-[var(--warning-ink)]" data-testid={`policies-untouched-${d.slug}`}>
                                                    <AlertTriangle size={10} aria-hidden="true" />
                                                    {t('compliance.policies_not_customised', 'Template not customised')}
                                                </span>
                                            )}
                                        </span>
                                    </span>
                                </TableCell>
                                <TableCell column={ctx.columns[2]}>
                                    {published && typeof d.ack_count === 'number' ? (
                                        // An acknowledgement count the server did not state is
                                        // not zero acknowledgements — it renders nothing.
                                        <span className="inline-flex items-center gap-1 text-[var(--text-secondary)] tabular-nums" data-testid={`policies-acks-${d.slug}`}>
                                            <Users size={11} aria-hidden="true" />
                                            {memberTotal === null ? d.ack_count : `${d.ack_count} / ${memberTotal}`}
                                        </span>
                                    ) : (
                                        <span className="text-[var(--text-tertiary)]">—</span>
                                    )}
                                </TableCell>
                                <TableCell column={ctx.columns[3]}>
                                    <StatusPill tone={published ? 'success' : 'warning'} testId={`policies-status-${d.slug}`}>
                                        {published ? t('compliance.policies_status_published', 'Published') : t('compliance.policies_draft', 'Draft')}
                                    </StatusPill>
                                </TableCell>
                                <TableCell column={ctx.columns[4]}>
                                    <span className="truncate text-[var(--text-secondary)]">{userName(orgUsers, d.owner_user_id) || '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[5]}>
                                    {d.review_due_at
                                        ? <DeadlineClock dueAt={d.review_due_at} variant="inline" testId={`policies-clock-${d.slug}`} />
                                        : <span className="text-[var(--text-tertiary)]">—</span>}
                                </TableCell>
                            </TableRow>
                        );
                    }}
                    renderCard={(d) => (
                        <button
                            type="button"
                            onClick={() => setOpenSlug(prev => (prev === d.slug ? null : d.slug))}
                            className="w-full text-left flex flex-col gap-1 px-3.5 py-2.5"
                            data-testid={`policies-card-${d.slug}`}
                        >
                            <span className="font-mono text-[11px] text-[var(--text-tertiary)]">{d.slug}</span>
                            <span className="text-xs font-semibold text-[var(--text-primary)]">{d.title}</span>
                            <span className="text-[11px] text-[var(--text-tertiary)]">
                                {d.status === 'published'
                                    ? t('compliance.policies_published_v', 'Published v{version}', { version: d.current_version })
                                    : t('compliance.policies_draft', 'Draft')}
                                {d.review_due_at ? ` · ${fmtDate(d.review_due_at, resolvedLocale)}` : ''}
                            </span>
                        </button>
                    )}
                />
            )}
        </RegisterLayout>
    );
}
