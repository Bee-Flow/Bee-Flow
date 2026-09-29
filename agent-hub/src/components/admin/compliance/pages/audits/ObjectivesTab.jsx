import React, { useState } from 'react';
import { Plus, CheckCircle2 } from 'lucide-react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../../shared/DataTable';
import SideDrawer from '../../../../shared/SideDrawer';
import DeadlineClock from '../../../../shared/DeadlineClock';
import EmptyState from '../../../../shared/EmptyState';
import StatusPill from '../../shared/StatusPill';
import {
    OBJ_STATUS, labelOf, toneOf, userName, isOverdue,
    Field, TextInput, DateInput, UserSelect, ActionButton, Intro, RegisterLayout,
} from './auditForms';

/**
 * ObjectivesTab — security objectives (clause 6.2): measurable, owned,
 * reviewed on a date. Row actions flip the status; the drawer only holds the
 * add form (an objective has no detail beyond its row).
 */
const EMPTY_DRAFT = Object.freeze({ title: '', measure: '', target: '', review_due_at: '', owner_user_id: '' });

export default function ObjectivesTab({ audit, orgUsers, isMobile = false }) {
    const { t } = useTranslation();
    const { objectives, busy, createObjective, updateObjective } = audit;
    const loading = objectives === null || objectives === undefined;
    const list = Array.isArray(objectives) ? objectives : [];

    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);

    const submit = () => {
        if (!draft.title.trim()) return;
        createObjective({
            title: draft.title.trim(),
            measure: draft.measure.trim() || undefined,
            target: draft.target.trim() || undefined,
            review_due_at: draft.review_due_at || undefined,
            owner_user_id: draft.owner_user_id || undefined,
        });
        setDraft(EMPTY_DRAFT);
        setCreating(false);
    };

    const columns = [
        { id: 'objective', width: '1.3fr', label: t('compliance.obj_col_objective', 'Objective') },
        { id: 'measure', width: '1fr', label: t('compliance.obj_col_measure', 'Measure'), foldBelow: 1180 },
        { id: 'target', width: '110px', label: t('compliance.obj_col_target', 'Target'), foldBelow: 1180 },
        { id: 'review', width: '130px', label: t('compliance.obj_col_review', 'Review due') },
        { id: 'owner', width: '130px', label: t('compliance.obj_col_owner', 'Owner'), foldBelow: 1180 },
        { id: 'status', width: '96px', label: t('compliance.obj_col_status', 'Status') },
        { id: 'actions', width: '200px', label: '' },
    ];

    const drawer = creating ? (
        <SideDrawer open onClose={() => setCreating(false)} mode={isMobile ? 'modal' : 'inline'} ariaLabel={t('compliance.obj_add', 'Add objective')} testId="objective-create-drawer"
            header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{t('compliance.obj_add', 'Add objective')}</div>}
            footer={(
                <div className="flex gap-2">
                    <ActionButton variant="primary" disabled={busy || !draft.title.trim()} onClick={submit} data-testid="objective-create-submit">{t('compliance.obj_create', 'Add objective')}</ActionButton>
                    <ActionButton onClick={() => setCreating(false)}>{t('compliance.audit_cancel', 'Cancel')}</ActionButton>
                </div>
            )}>
            <Field label={t('compliance.obj_f_title', 'Objective')}>
                <TextInput value={draft.title} autoFocus onChange={v => setDraft(d => ({ ...d, title: v }))} data-testid="objective-f-title" />
            </Field>
            <Field label={t('compliance.obj_f_measure', 'How it is measured')}>
                <TextInput value={draft.measure} placeholder={t('compliance.obj_f_measure_ph', 'e.g. phishing-test click rate')} onChange={v => setDraft(d => ({ ...d, measure: v }))} />
            </Field>
            <Field label={t('compliance.obj_f_target', 'Target')}>
                <TextInput value={draft.target} placeholder={t('compliance.obj_f_target_ph', 'e.g. below 5%')} onChange={v => setDraft(d => ({ ...d, target: v }))} />
            </Field>
            <Field label={t('compliance.obj_f_review', 'Next review')}>
                <DateInput value={draft.review_due_at} onChange={v => setDraft(d => ({ ...d, review_due_at: v }))} />
            </Field>
            <Field label={t('compliance.obj_f_owner', 'Owner')}>
                <UserSelect value={draft.owner_user_id} orgUsers={orgUsers} noneLabel={t('compliance.nc_owner_none', 'No owner')} onChange={v => setDraft(d => ({ ...d, owner_user_id: v }))} />
            </Field>
        </SideDrawer>
    ) : null;

    return (
        <RegisterLayout isMobile={isMobile} testId="objectives-tab" drawer={drawer}
            toolbar={(
                <>
                    <Intro>{t('compliance.obj_subtitle', 'Security objectives (clause 6.2): measurable, owned and reviewed on a date — not aspirations.')}</Intro>
                    <ActionButton variant="primary" icon={Plus} onClick={() => setCreating(true)} data-testid="objective-add">{t('compliance.obj_add', 'Add objective')}</ActionButton>
                </>
            )}>
            <DataTable
                columns={columns}
                rows={list}
                loading={loading}
                isMobile={isMobile}
                rowKey={(o) => o.id}
                ariaLabel={t('compliance.obj_tab', 'Objectives')}
                testId="objectives-table"
                empty={<EmptyState title={t('compliance.obj_empty_title', 'No security objectives yet')} description={t('compliance.obj_empty', 'No security objectives yet. Clause 6.2 asks for measurable objectives with owners and review dates.')} />}
                renderCard={(o) => {
                    const active = o.status === 'active';
                    return (
                        <div className={`w-full min-w-0 flex flex-col gap-1.5 ${o.status === 'dropped' ? 'opacity-60' : ''}`.trim()} data-testid={`objective-card-${o.id}`}>
                            <span className="flex items-center gap-2 min-w-0">
                                <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{o.title}</span>
                                <StatusPill tone={toneOf(OBJ_STATUS, o.status)}>{labelOf(t, OBJ_STATUS, o.status)}</StatusPill>
                            </span>
                            <span className="text-[11px] text-[var(--text-tertiary)] truncate">{o.measure || '—'} · {o.target || '—'}</span>
                            <span className="flex items-center gap-2 min-w-0 text-[11px] text-[var(--text-secondary)]">
                                {o.review_due_at
                                    ? <DeadlineClock variant="inline" dueAt={o.review_due_at} doneAt={active ? undefined : (o.updated_at || o.review_due_at)} testId={`objective-clock-card-${o.id}`} />
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                                <span className="truncate">{userName(orgUsers, o.owner_user_id) || '—'}</span>
                            </span>
                            <span className="flex gap-1.5 flex-wrap">
                                {active ? (
                                    <>
                                        <ActionButton variant="success" icon={CheckCircle2} disabled={busy} className="min-h-[44px]" onClick={() => updateObjective(o.id, { status: 'achieved' })} data-testid={`objective-achieve-card-${o.id}`}>{t('compliance.obj_mark_achieved', 'Mark achieved')}</ActionButton>
                                        <ActionButton disabled={busy} className="min-h-[44px]" onClick={() => updateObjective(o.id, { status: 'dropped' })} data-testid={`objective-drop-card-${o.id}`}>{t('compliance.obj_mark_dropped', 'Drop')}</ActionButton>
                                    </>
                                ) : (
                                    <ActionButton disabled={busy} className="min-h-[44px]" onClick={() => updateObjective(o.id, { status: 'active' })} data-testid={`objective-reactivate-card-${o.id}`}>{t('compliance.obj_reactivate', 'Reactivate')}</ActionButton>
                                )}
                            </span>
                        </div>
                    );
                }}
                renderRow={(o, ctx) => {
                    const active = o.status === 'active';
                    const overdue = isOverdue(o.review_due_at, { closed: !active });
                    return (
                        <TableRow key={o.id} columns={ctx.columns} accent={overdue ? 'error' : toneOf(OBJ_STATUS, o.status)} className={o.status === 'dropped' ? 'opacity-60' : ''} testId={`objective-row-${o.id}`}>
                            <TableCell column={ctx.columns[0]} className="font-semibold text-[var(--text-primary)] truncate">{o.title}</TableCell>
                            <TableCell column={ctx.columns[1]} className="truncate text-[var(--text-secondary)]">{o.measure || '—'}</TableCell>
                            <TableCell column={ctx.columns[2]} className="truncate text-[var(--text-secondary)]">{o.target || '—'}</TableCell>
                            <TableCell column={ctx.columns[3]}>
                                {o.review_due_at
                                    ? <DeadlineClock variant="inline" dueAt={o.review_due_at} doneAt={active ? undefined : (o.updated_at || o.review_due_at)} testId={`objective-clock-${o.id}`} />
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[4]} className="truncate text-[var(--text-secondary)]">{userName(orgUsers, o.owner_user_id) || '—'}</TableCell>
                            <TableCell column={ctx.columns[5]}><StatusPill tone={toneOf(OBJ_STATUS, o.status)}>{labelOf(t, OBJ_STATUS, o.status)}</StatusPill></TableCell>
                            <TableCell column={ctx.columns[6]}>
                                <div className="flex gap-1.5 flex-wrap">
                                    {active ? (
                                        <>
                                            <ActionButton size="sm" variant="success" icon={CheckCircle2} disabled={busy} onClick={() => updateObjective(o.id, { status: 'achieved' })} data-testid={`objective-achieve-${o.id}`}>{t('compliance.obj_mark_achieved', 'Mark achieved')}</ActionButton>
                                            <ActionButton size="sm" disabled={busy} onClick={() => updateObjective(o.id, { status: 'dropped' })} data-testid={`objective-drop-${o.id}`}>{t('compliance.obj_mark_dropped', 'Drop')}</ActionButton>
                                        </>
                                    ) : (
                                        <ActionButton size="sm" disabled={busy} onClick={() => updateObjective(o.id, { status: 'active' })} data-testid={`objective-reactivate-${o.id}`}>{t('compliance.obj_reactivate', 'Reactivate')}</ActionButton>
                                    )}
                                </div>
                            </TableCell>
                        </TableRow>
                    );
                }}
            />
        </RegisterLayout>
    );
}
