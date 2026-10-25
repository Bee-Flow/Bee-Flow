import { CheckCircle2, Repeat } from 'lucide-react';
import React from 'react';
import { userName, labelOf, ActionButton, ReadFailed } from './audits/auditForms';
import type { OrgUser } from './accessAuditLabels';
import { TranslateParams } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import EmptyState from '../../../shared/EmptyState';
import type { Obligation, TrainingState } from './TrainingPage.types';

export const OBLIGATION_KINDS = Object.freeze({
    policy_review: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_policy_review', en: 'Policy review' }),
    soa_review: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_soa_review', en: 'SoA review' }),
    internal_audit: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_internal_audit', en: 'Internal audit' }),
    management_review: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_management_review', en: 'Management review' }),
    training: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_training', en: 'Training' }),
    access_review: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_access_review', en: 'Access review' }),
    supplier_review: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_supplier_review', en: 'Supplier review' }),
    pentest: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_pentest', en: 'Penetration test' }),
    custom: Object.freeze({ tone: 'neutral', key: 'compliance.obl_kind_custom', en: 'Other' }),
});

export function TrainingPageSection2({ t, oblFailed, oblColumns, oblRows, oblLoading, isMobile, orgUsers, doneOn, state }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; oblFailed: boolean; oblColumns: ({ label: string; id: "kind"; width: "150px"; } | { label: string; id: "title"; width: "1fr"; } | { label: string; id: "due"; width: "170px"; } | { label: string; id: "owner"; width: "150px"; foldBelow: 1180; } | { label: string; id: "action"; width: "130px"; })[]; oblRows: Obligation[]; oblLoading: boolean; isMobile: boolean; orgUsers: OrgUser[] | null; doneOn: (o: Obligation) => string; state: TrainingState; }) {
    return <section className="flex flex-col gap-2" data-testid="training-obligations">
        <h3 className="m-0 text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5">
            {t('compliance.obl_title', 'Obligations')}
        </h3>
        {oblFailed ? (
            <ReadFailed testId="training-obligations-failed">
                {t('compliance.obl_failed', 'The obligation list could not be read.')}
            </ReadFailed>
        ) : (
            <DataTable
                columns={oblColumns}
                rows={oblRows}
                loading={oblLoading}
                isMobile={isMobile}
                ariaLabel={t('compliance.obl_title', 'Obligations')}
                testId="training-obligations-table"
                empty={(
                    <EmptyState
                        title={t('compliance.obl_empty_title', 'Nothing on the clock')}
                        description={t('compliance.obl_empty', 'Add the reviews, audits and trainings your ISMS owes itself; recurring ones roll forward when you complete them.')} />
                )}
                renderCard={(o) => {
                    const done = !!o.completed_at;
                    return (
                        <div className="w-full min-w-0 flex items-center gap-2" data-testid={`obligation-card-${o.id}`}>
                            <div className="flex-1 min-w-0 flex flex-col gap-1">
                                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{o.title}</span>
                                <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                    {/* Separators only between the parts that exist. */}
                                    {[
                                        <span key="kind" className="text-[var(--text-secondary)]" data-testid={`obligation-kind-card-${o.id}`}>{labelOf(t, OBLIGATION_KINDS, o.kind)}</span>,
                                        o.subject ? <span key="subject">{o.subject}</span> : null,
                                        o.recur_months
                                            ? <span key="recur" className="inline-flex items-center gap-1"><Repeat size={10} aria-hidden="true" />{t('compliance.obl_recur_every', 'every {months} months', { months: o.recur_months })}</span>
                                            : null,
                                        userName(orgUsers, o.owner_user_id) ? <span key="owner">{userName(orgUsers, o.owner_user_id)}</span> : null,
                                    ].filter(Boolean).map((part, i) => <React.Fragment key={part?.key}>{i > 0 ? ' · ' : null}{part}</React.Fragment>)}
                                </span>
                                {done ? (
                                    <span className="text-[11px] text-[var(--text-secondary)] inline-flex items-center gap-1" data-testid={`obligation-done-card-${o.id}`}>
                                        <CheckCircle2 size={11} aria-hidden="true" className="text-[var(--success-ink)]" />{doneOn(o)}
                                    </span>
                                ) : <DeadlineClock dueAt={o.due_at} variant="inline" testId={`obligation-clock-card-${o.id}`} />}
                            </div>
                            {!done && (
                                <ActionButton variant="success" icon={CheckCircle2} disabled={state.busyId === o.id} onClick={() => state.completeObligation?.(o.id)}
                                    className="flex-shrink-0 min-h-[44px]" data-testid={`obligation-complete-card-${o.id}`}>{t('compliance.obl_complete', 'Complete')}</ActionButton>
                            )}
                        </div>
                    );
                } }
                renderRow={(o, ctx) => {
                    const done = !!o.completed_at;
                    return (
                        <TableRow columns={ctx.columns} accent={done ? 'success' : null} testId={`obligation-row-${o.id}`}>
                            <TableCell column={ctx.columns[0]} className="truncate text-[var(--text-secondary)]">
                                <span data-testid={`obligation-kind-${o.id}`}>{labelOf(t, OBLIGATION_KINDS, o.kind)}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                <span className="flex flex-col min-w-0">
                                    <span className="font-semibold text-[var(--text-primary)] truncate">{o.title}</span>
                                    <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                        {o.subject || ''}
                                        {o.subject && o.recur_months ? ' · ' : ''}
                                        {o.recur_months
                                            ? <span className="inline-flex items-center gap-1"><Repeat size={10} aria-hidden="true" />{t('compliance.obl_recur_every', 'every {months} months', { months: o.recur_months })}</span>
                                            : null}
                                    </span>
                                </span>
                            </TableCell>
                            <TableCell column={ctx.columns[2]}>
                                {done ? (
                                    <span className="text-[11px] text-[var(--text-secondary)] inline-flex items-center gap-1" data-testid={`obligation-done-${o.id}`}>
                                        <CheckCircle2 size={11} aria-hidden="true" className="text-[var(--success-ink)]" />{doneOn(o)}
                                    </span>
                                ) : <DeadlineClock dueAt={o.due_at} variant="inline" testId={`obligation-clock-${o.id}`} />}
                            </TableCell>
                            <TableCell column={ctx.columns[3]}>
                                <span className="truncate text-[var(--text-secondary)]">{userName(orgUsers, o.owner_user_id) || '—'}</span>
                            </TableCell>
                            <TableCell column={ctx.columns[4]}>
                                {!done && (
                                    <ActionButton size="sm" variant="success" icon={CheckCircle2} disabled={state.busyId === o.id} onClick={() => state.completeObligation?.(o.id)}
                                        data-testid={`obligation-complete-${o.id}`}>{t('compliance.obl_complete', 'Complete')}</ActionButton>
                                )}
                            </TableCell>
                        </TableRow>
                    );
                } } />
        )}
    </section>;
}
