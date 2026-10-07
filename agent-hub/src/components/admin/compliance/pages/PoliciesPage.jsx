import React, { useMemo, useState } from 'react';
import { Sprout, AlertTriangle, Users } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import EmptyState from '../../../shared/EmptyState';
import useDrawerMode from '../shared/useDrawerMode';
import { userName, fmtDate, ActionButton, Intro, ReadFailed, RegisterLayout } from './audits/auditForms';
import PolicyDrawer, { POLICY_DRAWER_WIDTH, PolicyStatusPill } from './policies/PolicyDrawer';

/**
 * PoliciesPage — the ISMS document register (ISO 27001 A.5.1 / clause 7.5) on
 * the shared table + drawer pattern.
 *
 * `data.policies = { docs, busySlug, refresh, seed(), loadDoc(slug),
 * save(slug, patch), publish(slug) }` — the legacy page's onSeed/onLoadDoc/
 * onSave/onPublish under the hub's names. `docs` is
 * `{ documents: [], missing_seeds: [] }`; `null` is "not read yet" and a
 * non-object is a failed read, which is its own state, never an empty list.
 *
 * Title · Acknowledged · Status · Owner · Review due. The status is said once,
 * in the pill, with the version ("Published · v3" / "Draft"). The line under
 * the title carries only exceptions ("template not customised", "review
 * overdue {date}"), so a red stripe always has its reason on the row. The
 * slug is the drawer's muted id. Below 900px of card width Owner and Review
 * due fold and join that line.
 */

const COLUMNS = Object.freeze([
    Object.freeze({ id: 'title', label: 'compliance.policies_col_title', width: '1fr' }),
    Object.freeze({ id: 'acks', label: 'compliance.policies_col_acks', width: '110px' }),
    Object.freeze({ id: 'status', label: 'compliance.policies_col_status', width: '130px' }),
    Object.freeze({ id: 'owner', label: 'compliance.policies_col_owner', width: '150px', foldBelow: 900 }),
    Object.freeze({ id: 'review', label: 'compliance.policies_col_review', width: '150px', foldBelow: 900 }),
]);

const COLUMN_FALLBACKS = Object.freeze({
    title: 'Title', acks: 'Acknowledged', status: 'Status', owner: 'Owner', review: 'Review due',
});

export function isReviewOverdue(doc, now = Date.now()) {
    if (!doc?.review_due_at) return false;
    const ms = new Date(doc.review_due_at).getTime();
    return !Number.isNaN(ms) && ms < now;
}

/** "6 / 6" (or "6" when the member total is unknown); nothing the server did not state. */
function AckCount({ doc, memberTotal, testId }) {
    if (doc.status !== 'published' || typeof doc.ack_count !== 'number') return null;
    return (
        <span className="inline-flex items-center gap-1 text-[var(--text-secondary)] tabular-nums whitespace-nowrap" data-testid={testId}>
            <Users size={11} aria-hidden="true" />
            {memberTotal === null ? doc.ack_count : `${doc.ack_count} / ${memberTotal}`}
        </span>
    );
}

/** The exceptions of a row, in the warning / error ink with a glyph: not customised, review overdue. */
function rowExceptions({ doc, locale, t }) {
    const overdue = isReviewOverdue(doc);
    const parts = [];
    if (!doc.edited) {
        parts.push(
            <span key="untouched" className="inline-flex items-center gap-1 text-[var(--warning-ink)]" data-testid={`policies-untouched-${doc.slug}`}>
                <AlertTriangle size={10} aria-hidden="true" />
                {t('compliance.policies_not_customised', 'template not customised')}
            </span>,
        );
    }
    if (overdue) {
        parts.push(
            <span key="overdue" className="inline-flex items-center gap-1 text-[var(--error-ink)]" data-testid={`policies-overdue-${doc.slug}`}>
                {!parts.length && <AlertTriangle size={10} aria-hidden="true" />}
                {t('compliance.pol_review_overdue', 'review overdue {date}', { date: fmtDate(doc.review_due_at, locale) })}
            </span>,
        );
    }
    return parts.length ? parts.reduce((acc, el, i) => (i ? [...acc, <span key={`sep${i}`} aria-hidden="true"> · </span>, el] : [el]), []) : null;
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
    const [frameRef, drawerMode] = useDrawerMode({ isMobile, drawerWidth: POLICY_DRAWER_WIDTH });

    const columns = COLUMNS.map(c => ({ ...c, label: t(c.label, COLUMN_FALLBACKS[c.id]) }));
    const toggle = (slug) => setOpenSlug(prev => (prev === slug ? null : slug));

    const drawer = selected && (
        <PolicyDrawer
            doc={selected}
            orgUsers={orgUsers}
            busy={state.busySlug === selected.slug}
            onLoadDoc={state.loadDoc}
            onSave={state.save}
            onPublish={state.publish}
            onClose={() => setOpenSlug(null)}
            mode={drawerMode}
        />
    );

    return (
        <RegisterLayout
            isMobile={isMobile}
            drawerMode={drawerMode}
            frameRef={frameRef}
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
                        const owner = userName(orgUsers, d.owner_user_id);
                        const exceptions = rowExceptions({ doc: d, locale: resolvedLocale, t });
                        return (
                            <TableRow
                                columns={ctx.columns}
                                accent={overdue ? 'error' : (published ? 'success' : 'warning')}
                                selected={openSlug === d.slug}
                                onClick={() => toggle(d.slug)}
                                testId={`policies-row-${d.slug}`}
                            >
                                <TableCell column={ctx.columns[0]}>
                                    <span className="flex flex-col min-w-0">
                                        <span className="font-semibold text-[var(--text-primary)] truncate" title={d.title}>{d.title}</span>
                                        {/* Only exceptions; the folded Owner / Review due join them below 900px. */}
                                        <span className={`text-[11px] text-[var(--text-tertiary)] truncate ${exceptions ? '' : TABLE_FOLDED_ONLY[900]}`.trim()} data-testid={`policies-meta-${d.slug}`}>
                                            {exceptions}
                                            <span className={TABLE_FOLDED_ONLY[900]} data-testid={`policies-folded-${d.slug}`}>
                                                {exceptions ? ' · ' : ''}
                                                {owner || t('compliance.risk_owner_none', 'No owner')}
                                                {d.review_due_at && !overdue ? ` · ${t('compliance.policies_review_due', 'Review due')} ${fmtDate(d.review_due_at, resolvedLocale)}` : ''}
                                            </span>
                                        </span>
                                    </span>
                                </TableCell>
                                <TableCell column={ctx.columns[1]}>
                                    {/* An acknowledgement count the server did not state is not zero acknowledgements. */}
                                    <AckCount doc={d} memberTotal={memberTotal} testId={`policies-acks-${d.slug}`} />
                                    {!(published && typeof d.ack_count === 'number') && <span className="text-[var(--text-tertiary)]">—</span>}
                                </TableCell>
                                <TableCell column={ctx.columns[2]}>
                                    <PolicyStatusPill status={d.status} version={d.current_version} testId={`policies-status-${d.slug}`} />
                                </TableCell>
                                <TableCell column={ctx.columns[3]}>
                                    <span className="block truncate text-[var(--text-secondary)]" data-testid={`policies-owner-${d.slug}`}>{owner || '—'}</span>
                                </TableCell>
                                <TableCell column={ctx.columns[4]}>
                                    {d.review_due_at
                                        ? <DeadlineClock dueAt={d.review_due_at} variant="inline" testId={`policies-clock-${d.slug}`} />
                                        : <span className="text-[var(--text-tertiary)]">—</span>}
                                </TableCell>
                            </TableRow>
                        );
                    }}
                    renderCard={(d) => {
                        const exceptions = rowExceptions({ doc: d, locale: resolvedLocale, t });
                        const owner = userName(orgUsers, d.owner_user_id);
                        return (
                            <button
                                type="button"
                                onClick={() => toggle(d.slug)}
                                className="w-full min-w-0 text-left flex flex-col gap-1"
                                data-testid={`policies-card-${d.slug}`}
                            >
                                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{d.title}</span>
                                <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-[var(--text-tertiary)]">
                                    <PolicyStatusPill status={d.status} version={d.current_version} className="self-start" />
                                    <AckCount doc={d} memberTotal={memberTotal} />
                                    <span className="truncate">{owner || t('compliance.risk_owner_none', 'No owner')}</span>
                                </span>
                                {exceptions && <span className="text-[11px]">{exceptions}</span>}
                            </button>
                        );
                    }}
                />
            )}
        </RegisterLayout>
    );
}
