import { Plus, CheckCircle2 } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
    OBJ_STATUS, labelOf, toneOf, userName, isOverdue,
    Field, TextInput, DateInput, UserSelect, ActionButton, Intro, RegisterLayout,
} from './auditForms';
import ObjectiveDrawer from './ObjectiveDrawer';
import useHeaderPrimary from './useHeaderPrimary';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../../shared/DataTable';
import DeadlineClock from '../../../../shared/DeadlineClock';
import EmptyState from '../../../../shared/EmptyState';
import SideDrawer from '../../../../shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import useDrawerMode from '../../shared/useDrawerMode';

/**
 * ObjectivesTab — security objectives (clause 6.2): measurable, owned,
 * reviewed on a date. A row opens ObjectiveDrawer (measure, target, owner,
 * review date, and the Mark achieved / Drop / Reactivate steps); the table
 * keeps four columns, with "measure → target" under the title, so a title
 * reads on one line. The phone card keeps its buttons: there is no table
 * beside it to make room for.
 */
const EMPTY_DRAFT = Object.freeze({ title: '', measure: '', target: '', review_due_at: '', owner_user_id: '' });

export default function ObjectivesTab({ audit, orgUsers, isMobile = false, focusId = null, setHeaderActions = undefined }) {
    const { t } = useTranslation();
    const { objectives, busy, createObjective, updateObjective } = audit;
    const loading = objectives === null || objectives === undefined;
    const list = useMemo(() => (Array.isArray(objectives) ? objectives : []), [objectives]);
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });

    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [selectedId, setSelectedId] = useState(focusId || null);
    const [seenFocusId, setSeenFocusId] = useState(focusId);
    if (seenFocusId !== focusId) {
        setSeenFocusId(focusId);
        if (focusId) setSelectedId(String(focusId));
    }
    const selected = useMemo(() => list.find(o => String(o.id) === String(selectedId)) || null, [list, selectedId]);

    const addLabel = t('compliance.obj_add', 'Add objective');
    const headerHasCreate = useHeaderPrimary(setHeaderActions, {
        label: addLabel, icon: Plus, onClick: () => { setSelectedId(null); setCreating(true); },
    });

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

    /** "Phishing click rate → below 5%", or whichever half is known. */
    const measureTarget = (o) => {
        if (o.measure && o.target) return t('compliance.obj_measure_target', '{measure} → {target}', { measure: o.measure, target: o.target });
        return o.measure || o.target || '';
    };

    const columns = [
        { id: 'objective', width: '1fr', label: t('compliance.obj_col_objective', 'Objective') },
        { id: 'review', width: '130px', label: t('compliance.obj_col_review', 'Review due') },
        { id: 'owner', width: '140px', label: t('compliance.obj_col_owner', 'Owner'), foldBelow: 900 },
        { id: 'status', width: '104px', label: t('compliance.obj_col_status', 'Status') },
    ];

    let drawer = null;
    if (creating) {
        drawer = (
            <SideDrawer open onClose={() => setCreating(false)} mode={drawerMode} ariaLabel={addLabel} testId="objective-create-drawer"
                header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{addLabel}</div>}
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
        );
    } else if (selected) {
        drawer = (
            <ObjectiveDrawer objective={selected} orgUsers={orgUsers} busy={busy} mode={drawerMode}
                onClose={() => setSelectedId(null)} onStatus={(status) => updateObjective(selected.id, { status })} />
        );
    }

    const toggle = (o) => { setCreating(false); setSelectedId(prev => (String(prev) === String(o.id) ? null : o.id)); };

    return (
        <RegisterLayout isMobile={isMobile} drawerMode={drawerMode} frameRef={frameRef} testId="objectives-tab" drawer={drawer}
            toolbar={(
                <>
                    <Intro>{t('compliance.obj_subtitle', 'Security objectives (clause 6.2): measurable, owned and reviewed on a date — not aspirations.')}</Intro>
                    {!headerHasCreate && <ActionButton variant="primary" icon={Plus} onClick={() => { setSelectedId(null); setCreating(true); }} data-testid="objective-add">{addLabel}</ActionButton>}
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
                                <RegisterStatePill state={o.status} testId={`objective-card-state-${o.id}`}>{labelOf(t, OBJ_STATUS, o.status)}</RegisterStatePill>
                            </span>
                            <span className="text-[11px] text-[var(--text-tertiary)] truncate">{measureTarget(o) || '—'}</span>
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
                    const mt = measureTarget(o);
                    const owner = userName(orgUsers, o.owner_user_id);
                    return (
                        <TableRow key={o.id} columns={ctx.columns} accent={overdue ? 'error' : toneOf(OBJ_STATUS, o.status)} className={o.status === 'dropped' ? 'opacity-60' : ''}
                            selected={!creating && String(selectedId) === String(o.id)} onClick={() => toggle(o)} testId={`objective-row-${o.id}`}>
                            <TableCell column={ctx.columns[0]} className="min-w-0">
                                <div className="font-semibold text-[var(--text-primary)] truncate" title={o.title}>{o.title}</div>
                                <div className="text-[11px] text-[var(--text-tertiary)] truncate" data-testid={`objective-measure-${o.id}`}>
                                    {mt}
                                    {/* The owner while the Owner column is folded. */}
                                    {owner && <span className={TABLE_FOLDED_ONLY[900]}>{mt ? ' · ' : ''}{owner}</span>}
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}>
                                {o.review_due_at
                                    ? <DeadlineClock variant="inline" dueAt={o.review_due_at} doneAt={active ? undefined : (o.updated_at || o.review_due_at)} testId={`objective-clock-${o.id}`} />
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[2]} className="truncate text-[var(--text-secondary)]">{owner || '—'}</TableCell>
                            <TableCell column={ctx.columns[3]}><RegisterStatePill state={o.status} testId={`objective-state-${o.id}`}>{labelOf(t, OBJ_STATUS, o.status)}</RegisterStatePill></TableCell>
                        </TableRow>
                    );
                }}
            />
        </RegisterLayout>
    );
}
