import { Plus, ArrowRight, CheckCircle2, ShieldCheck } from 'lucide-react';
import React, { useId, useMemo, useState } from 'react';
import {
    NC_STATUS, NC_SEVERITY, NC_SOURCE, labelOf, toneOf, userName, fmtDate, dateInputValue, isOverdue,
    Field, TextInput, TextArea, DateInput, Select, UserSelect, ActionButton, Intro, RegisterLayout,
} from './auditForms';
import { editPatch } from './isoProcessHelpers';
import useHeaderPrimary from './useHeaderPrimary';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell, TABLE_FOLDED_ONLY } from '../../../../shared/DataTable';
import DeadlineClock from '../../../../shared/DeadlineClock';
import EmptyState from '../../../../shared/EmptyState';
import SideDrawer, { DrawerSection, DrawerFooter } from '../../../../shared/SideDrawer';
import RegisterStatePill from '../../shared/RegisterStatePill';
import StatusPill from '../../shared/StatusPill';
import useDrawerMode from '../../shared/useDrawerMode';

/**
 * NcsTab — the nonconformity register (clause 10): open → corrective action
 * → effectiveness review → closed. The drawer edits the corrective action,
 * dates and owner, and carries the state transitions; closing goes through
 * `confirm_effectiveness: true` so the server records who confirmed it.
 *
 * A step is ONE write that carries the drawer's edits with the new status
 * (isoProcessHelpers' editPatch), so a corrective action typed into the
 * drawer is never lost when the step is taken instead of Save. Moving on to
 * the effectiveness review, and closing, wait for a written corrective action.
 */
const EMPTY_DRAFT = Object.freeze({ title: '', description: '', severity: 'minor', due_at: '', owner_user_id: '' });

const editFrom = (nc) => ({
    corrective_action: nc.corrective_action || '',
    due_at: dateInputValue(nc.due_at),
    effectiveness_review_due_at: dateInputValue(nc.effectiveness_review_due_at),
    owner_user_id: nc.owner_user_id || '',
});

/** The next step of an NC: its button and the status it writes (null when there is none). */
function stepOf(nc, t) {
    if (nc.status === 'open') {
        return { label: t('compliance.nc_start_ca', 'Start corrective action'), icon: ArrowRight, testId: 'nc-start-ca', patch: { status: 'corrective_action' }, needsCa: false };
    }
    if (nc.status === 'corrective_action') {
        return { label: t('compliance.nc_to_er', 'Move to effectiveness review'), icon: ArrowRight, testId: 'nc-to-er', patch: { status: 'effectiveness_review' }, needsCa: true };
    }
    if (nc.status === 'effectiveness_review') {
        return { label: t('compliance.nc_confirm_close', 'Confirm effectiveness & close'), icon: CheckCircle2, testId: 'nc-confirm-close', patch: { status: 'closed', confirm_effectiveness: true }, needsCa: true };
    }
    return null;
}

export default function NcsTab({ audit, orgUsers, isMobile = false, focusId = null, setHeaderActions = undefined }) {
    const { t, resolvedLocale } = useTranslation();
    const { ncs, busy, createNc, updateNc } = audit;
    const loading = ncs === null || ncs === undefined;
    const list = useMemo(() => (Array.isArray(ncs) ? ncs : []), [ncs]);
    const hintId = useId();
    const [frameRef, drawerMode] = useDrawerMode({ isMobile });

    const [selectedId, setSelectedId] = useState(focusId || null);
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);
    const [edit, setEdit] = useState(null);
    const [seenFocusId, setSeenFocusId] = useState(focusId);
    if (seenFocusId !== focusId) {
        setSeenFocusId(focusId);
        if (focusId) setSelectedId(String(focusId));
    }
    const selected = useMemo(() => list.find(n => String(n.id) === String(selectedId)) || null, [list, selectedId]);
    // A fresh edit draft whenever another row is opened; the draft survives re-renders of the same row.
    const selectedKey = selected?.id;
    const [editedKey, setEditedKey] = useState(selectedKey);
    if (editedKey !== selectedKey) {
        setEditedKey(selectedKey);
        setEdit(selected ? editFrom(selected) : null);
    }

    const recordLabel = t('compliance.nc_record', 'Record nonconformity');
    const headerHasCreate = useHeaderPrimary(setHeaderActions, {
        label: recordLabel, icon: Plus, onClick: () => { setSelectedId(null); setCreating(true); },
    });

    const submit = () => {
        if (!draft.title.trim()) return;
        createNc({
            title: draft.title.trim(),
            description: draft.description.trim() || undefined,
            severity: draft.severity,
            due_at: draft.due_at || undefined,
            owner_user_id: draft.owner_user_id || undefined,
            source: 'manual',
        });
        setDraft(EMPTY_DRAFT);
        setCreating(false);
    };
    const saveEdit = (id) => {
        if (!edit) return;
        updateNc(id, editPatch(edit));
    };

    const columns = [
        { id: 'title', width: '1fr', label: t('compliance.nc_f_title', 'Title') },
        { id: 'status', width: '150px', label: t('compliance.obj_col_status', 'Status') },
        { id: 'severity', width: '84px', label: t('compliance.nc_f_severity', 'Severity'), foldBelow: 900 },
        { id: 'source', width: '120px', label: t('compliance.nc_col_source', 'Source'), foldBelow: 1180 },
        { id: 'due', width: '140px', label: t('compliance.nc_f_due', 'Corrective action due') },
        { id: 'owner', width: '130px', label: t('compliance.nc_f_owner', 'Owner'), foldBelow: 900 },
    ];

    let drawer = null;
    if (creating) {
        drawer = (
            <SideDrawer open onClose={() => setCreating(false)} mode={drawerMode} ariaLabel={recordLabel} testId="nc-create-drawer"
                header={<div className="text-[13px] font-semibold text-[var(--text-primary)]">{recordLabel}</div>}
                footer={(
                    <div className="flex gap-2">
                        <ActionButton variant="primary" disabled={busy || !draft.title.trim()} onClick={submit} data-testid="nc-create-submit">{t('compliance.nc_create', 'Record')}</ActionButton>
                        <ActionButton onClick={() => setCreating(false)}>{t('compliance.audit_cancel', 'Cancel')}</ActionButton>
                    </div>
                )}>
                <Field label={t('compliance.nc_f_title', 'Title')}>
                    <TextInput value={draft.title} autoFocus onChange={v => setDraft(d => ({ ...d, title: v }))} data-testid="nc-f-title" />
                </Field>
                <Field label={t('compliance.nc_f_desc', 'Description')}>
                    <TextArea rows={3} value={draft.description} placeholder={t('compliance.nc_f_desc_ph', 'What is nonconforming, how was it detected, what is the impact?')} onChange={v => setDraft(d => ({ ...d, description: v }))} />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                    <Field label={t('compliance.nc_f_severity', 'Severity')}>
                        <Select value={draft.severity} onChange={v => setDraft(d => ({ ...d, severity: v }))} data-testid="nc-f-severity"
                            options={Object.keys(NC_SEVERITY).map(k => ({ value: k, label: labelOf(t, NC_SEVERITY, k) }))} />
                    </Field>
                    <Field label={t('compliance.nc_f_due', 'Corrective action due')}>
                        <DateInput value={draft.due_at} onChange={v => setDraft(d => ({ ...d, due_at: v }))} />
                    </Field>
                </div>
                <Field label={t('compliance.nc_f_owner', 'Owner')}>
                    <UserSelect value={draft.owner_user_id} orgUsers={orgUsers} noneLabel={t('compliance.nc_owner_none', 'No owner')} onChange={v => setDraft(d => ({ ...d, owner_user_id: v }))} />
                </Field>
            </SideDrawer>
        );
    } else if (selected) {
        const nc = selected;
        const closed = nc.status === 'closed';
        const step = stepOf(nc, t);
        // The step waits for a written corrective action; the hint says why the button is off.
        const blocked = !!step?.needsCa && !String(edit?.corrective_action || '').trim();
        const stepButton = step ? (
            <ActionButton variant="primary" icon={step.icon} disabled={busy || blocked}
                onClick={() => updateNc(nc.id, { ...editPatch(edit), ...step.patch })}
                aria-describedby={blocked ? hintId : undefined} data-testid={step.testId}>
                {step.label}
            </ActionButton>
        ) : null;
        drawer = (
            <SideDrawer open onClose={() => setSelectedId(null)} mode={drawerMode} ariaLabel={nc.title} testId="nc-drawer"
                header={(
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[13px] font-semibold text-[var(--text-primary)] truncate">{nc.title}</span>
                        <RegisterStatePill state={nc.status} testId="nc-drawer-state">{labelOf(t, NC_STATUS, nc.status)}</RegisterStatePill>
                    </div>
                )}
                footer={!closed ? (
                    <>
                        <DrawerFooter primary={stepButton} testId="nc-footer">
                            <ActionButton disabled={busy || !edit} onClick={() => saveEdit(nc.id)} data-testid="nc-save">{t('compliance.nc_save', 'Save')}</ActionButton>
                        </DrawerFooter>
                        {blocked && <div id={hintId} className="text-[11px] text-[var(--text-tertiary)]" data-testid="nc-needs-ca">{t('compliance.nc_needs_ca', 'Describe the corrective action first')}</div>}
                        {nc.status === 'effectiveness_review' && <div className="text-[11px] text-[var(--text-tertiary)]">{t('compliance.nc_confirm_hint', 'Closing records you, by name, as the person who confirmed the corrective action actually worked.')}</div>}
                    </>
                ) : null}>
                <DrawerSection label={t('compliance.nc_f_desc', 'Description')}>
                    <div className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{nc.description || '—'}</div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <StatusPill tone={toneOf(NC_SEVERITY, nc.severity)}>{labelOf(t, NC_SEVERITY, nc.severity)}</StatusPill>
                        <StatusPill>{labelOf(t, NC_SOURCE, nc.source)}</StatusPill>
                    </div>
                    {nc.effectiveness_confirmed_at && (
                        <div className="inline-flex items-center gap-1.5 text-xs text-[var(--success-ink)]" data-testid="nc-effectiveness">
                            <ShieldCheck size={13} aria-hidden="true" />
                            {t('compliance.nc_effectiveness_by', 'Effectiveness confirmed by')} {userName(orgUsers, nc.effectiveness_confirmed_by) || nc.effectiveness_confirmed_by} · {fmtDate(nc.effectiveness_confirmed_at, resolvedLocale)}
                        </div>
                    )}
                </DrawerSection>
                {!closed && edit && (
                    <DrawerSection label={t('compliance.nc_f_corrective', 'Corrective action')}>
                        <TextArea rows={3} value={edit.corrective_action} placeholder={t('compliance.nc_f_corrective_ph', 'What is being done to remove the cause, not just the symptom?')} onChange={v => setEdit(e => ({ ...e, corrective_action: v }))} data-testid="nc-f-corrective" />
                        <div className="grid grid-cols-2 gap-2">
                            <Field label={t('compliance.nc_f_due', 'Corrective action due')}>
                                <DateInput value={edit.due_at} onChange={v => setEdit(e => ({ ...e, due_at: v }))} />
                            </Field>
                            <Field label={t('compliance.nc_f_eff_due', 'Effectiveness review due')}>
                                <DateInput value={edit.effectiveness_review_due_at} onChange={v => setEdit(e => ({ ...e, effectiveness_review_due_at: v }))} />
                            </Field>
                        </div>
                        <Field label={t('compliance.nc_f_owner', 'Owner')}>
                            <UserSelect value={edit.owner_user_id} orgUsers={orgUsers} noneLabel={t('compliance.nc_owner_none', 'No owner')} onChange={v => setEdit(e => ({ ...e, owner_user_id: v }))} />
                        </Field>
                    </DrawerSection>
                )}
                {closed && nc.corrective_action && (
                    <DrawerSection label={t('compliance.nc_f_corrective', 'Corrective action')}>
                        <div className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{nc.corrective_action}</div>
                    </DrawerSection>
                )}
            </SideDrawer>
        );
    }

    const toggle = (nc) => { setCreating(false); setSelectedId(prev => (String(prev) === String(nc.id) ? null : nc.id)); };

    return (
        <RegisterLayout isMobile={isMobile} drawerMode={drawerMode} frameRef={frameRef} testId="ncs-tab" drawer={drawer}
            toolbar={(
                <>
                    <Intro>{t('compliance.nc_subtitle', 'Nonconformity register (clause 10): every deviation gets a corrective action, a due date and an effectiveness review before it may close.')}</Intro>
                    {!headerHasCreate && <ActionButton variant="primary" icon={Plus} onClick={() => { setSelectedId(null); setCreating(true); }} data-testid="nc-record">{recordLabel}</ActionButton>}
                </>
            )}>
            <DataTable
                columns={columns}
                rows={list}
                loading={loading}
                isMobile={isMobile}
                rowKey={(n) => n.id}
                ariaLabel={t('compliance.nc_tab', 'Nonconformities')}
                testId="ncs-table"
                empty={<EmptyState title={t('compliance.nc_empty_title', 'No nonconformities recorded')} description={t('compliance.nc_empty', 'No nonconformities recorded. That is only good news if you are genuinely finding none — audits and incidents should feed this register.')} />}
                renderCard={(nc) => {
                    const closed = nc.status === 'closed';
                    return (
                        <button
                            type="button"
                            onClick={() => toggle(nc)}
                            aria-selected={(!creating && String(selectedId) === String(nc.id)) || undefined}
                            className="w-full text-left min-h-[44px] flex flex-col justify-center gap-1 min-w-0"
                            data-testid={`nc-card-${nc.id}`}
                        >
                            <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{nc.title}</span>
                            <span className="flex items-center gap-2 min-w-0 text-[11px]">
                                <RegisterStatePill state={nc.status} testId={`nc-card-state-${nc.id}`}>{labelOf(t, NC_STATUS, nc.status)}</RegisterStatePill>
                                <StatusPill tone={toneOf(NC_SEVERITY, nc.severity)}>{labelOf(t, NC_SEVERITY, nc.severity)}</StatusPill>
                                <span className="truncate text-[var(--text-secondary)]">{labelOf(t, NC_SOURCE, nc.source)}</span>
                            </span>
                            <span className="flex items-center gap-2 min-w-0 text-[11px] text-[var(--text-secondary)]">
                                {nc.due_at
                                    ? <DeadlineClock variant="inline" dueAt={nc.due_at} doneAt={closed ? (nc.closed_at || nc.due_at) : undefined} testId={`nc-clock-card-${nc.id}`} />
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                                <span className="truncate">{userName(orgUsers, nc.owner_user_id) || '—'}</span>
                            </span>
                        </button>
                    );
                }}
                renderRow={(nc, ctx) => {
                    const closed = nc.status === 'closed';
                    const overdue = isOverdue(nc.due_at, { closed });
                    return (
                        <TableRow key={nc.id} columns={ctx.columns} accent={overdue ? 'error' : toneOf(NC_STATUS, nc.status)} selected={!creating && String(selectedId) === String(nc.id)}
                            onClick={() => toggle(nc)} testId={`nc-row-${nc.id}`}>
                            <TableCell column={ctx.columns[0]} className="min-w-0">
                                <div className="font-semibold text-[var(--text-primary)] truncate">{nc.title}</div>
                                <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                                    {/* The severity's word while its own column is folded. */}
                                    <span className={TABLE_FOLDED_ONLY[900]} data-testid={`nc-folded-severity-${nc.id}`}>{labelOf(t, NC_SEVERITY, nc.severity)}{nc.description ? ' · ' : ''}</span>
                                    {nc.description}
                                </div>
                            </TableCell>
                            <TableCell column={ctx.columns[1]}><RegisterStatePill state={nc.status} testId={`nc-state-${nc.id}`}>{labelOf(t, NC_STATUS, nc.status)}</RegisterStatePill></TableCell>
                            <TableCell column={ctx.columns[2]}><StatusPill tone={toneOf(NC_SEVERITY, nc.severity)}>{labelOf(t, NC_SEVERITY, nc.severity)}</StatusPill></TableCell>
                            <TableCell column={ctx.columns[3]} className="truncate text-[var(--text-secondary)]">{labelOf(t, NC_SOURCE, nc.source)}</TableCell>
                            <TableCell column={ctx.columns[4]}>
                                {nc.due_at
                                    ? <DeadlineClock variant="inline" dueAt={nc.due_at} doneAt={closed ? (nc.closed_at || nc.due_at) : undefined} testId={`nc-clock-${nc.id}`} />
                                    : <span className="text-[var(--text-tertiary)]">—</span>}
                            </TableCell>
                            <TableCell column={ctx.columns[5]} className="truncate text-[var(--text-secondary)]">{userName(orgUsers, nc.owner_user_id) || '—'}</TableCell>
                        </TableRow>
                    );
                }}
            />
        </RegisterLayout>
    );
}
