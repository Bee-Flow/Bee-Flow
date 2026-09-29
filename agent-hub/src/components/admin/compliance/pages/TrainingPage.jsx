import React, { useMemo, useState } from 'react';
import { GraduationCap, Plus, CheckCircle2, Repeat } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import DataTable, { TableRow, TableCell } from '../../../shared/DataTable';
import DeadlineClock from '../../../shared/DeadlineClock';
import SideDrawer, { DrawerSection } from '../../../shared/SideDrawer';
import EmptyState from '../../../shared/EmptyState';
import StatusPill from '../shared/StatusPill';
import maskEmail from '../shared/maskEmail';
import {
    userName, fmtDate, labelOf, Field, TextInput, DateInput, Select, UserSelect,
    ActionButton, Intro, ReadFailed, RegisterLayout,
} from './audits/auditForms';

/**
 * TrainingPage — personnel training (ISO 27001 cl. 7.2/7.3, AI Act Art. 4) and
 * the ISMS obligation clock, on the shared table pattern.
 *
 * `data.training = { personnel|null, obligations|null, busyId, refresh,
 * attest(userId, note), createObligation(fields), completeObligation(id) }` —
 * the legacy page's onAttest/onCreateObligation/onCompleteObligation.
 *
 * The legacy `DueBadge` is gone: every due date is a shared `DeadlineClock`
 * (`variant="inline"`), so a deadline reads the same here as on the overview.
 * A training attestation is valid for twelve months — that window IS the
 * personnel clock.
 */

/** An attestation is good for a year; without one there is no clock, not a red one. */
export const ATTESTATION_MONTHS = 12;

export function attestationDueAt(person, months = ATTESTATION_MONTHS) {
    const at = person?.attested_at;
    if (!at) return null;
    const ms = new Date(at).getTime();
    if (Number.isNaN(ms)) return null;
    const d = new Date(ms);
    d.setMonth(d.getMonth() + months);
    return d.toISOString();
}

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

const EMPTY_DRAFT = Object.freeze({ kind: 'policy_review', subject: '', title: '', due_at: '', recur_months: '', owner_user_id: '' });

const PERSON_COLUMNS = Object.freeze([
    Object.freeze({ id: 'member', label: 'compliance.training_col_member', width: '1fr' }),
    Object.freeze({ id: 'acks', label: 'compliance.training_col_acks', width: '120px' }),
    Object.freeze({ id: 'learning', label: 'compliance.training_col_learning', width: '120px', foldBelow: 1180 }),
    Object.freeze({ id: 'attested', label: 'compliance.training_col_attested', width: '170px' }),
    Object.freeze({ id: 'action', label: '', width: '150px' }),
]);
const PERSON_FALLBACKS = Object.freeze({ member: 'Member', acks: 'Policies', learning: 'Learning', attested: 'Training valid until' });

const OBL_COLUMNS = Object.freeze([
    Object.freeze({ id: 'kind', label: 'compliance.obl_col_kind', width: '150px' }),
    Object.freeze({ id: 'title', label: 'compliance.obl_col_title', width: '1fr' }),
    Object.freeze({ id: 'due', label: 'compliance.obl_col_due', width: '170px' }),
    Object.freeze({ id: 'owner', label: 'compliance.obl_col_owner', width: '150px', foldBelow: 1180 }),
    Object.freeze({ id: 'action', label: '', width: '130px' }),
]);
const OBL_FALLBACKS = Object.freeze({ kind: 'Kind', title: 'Obligation', due: 'Due', owner: 'Owner' });

export default function TrainingPage({ data = {}, isMobile = false }) {
    const { t } = useTranslation();
    const state = data.training || {};
    const orgUsers = data.orgUsers ?? null;
    const personnel = state.personnel;
    const obligations = state.obligations;

    const personnelLoading = personnel === null || personnel === undefined;
    const personnelFailed = !personnelLoading && !Array.isArray(personnel);
    const oblLoading = obligations === null || obligations === undefined;
    const oblFailed = !oblLoading && !Array.isArray(obligations);

    const [attestFor, setAttestFor] = useState(null);
    const [note, setNote] = useState('');
    const [creating, setCreating] = useState(false);
    const [draft, setDraft] = useState(EMPTY_DRAFT);

    const personRows = Array.isArray(personnel) ? personnel : [];
    const oblRows = Array.isArray(obligations) ? obligations : [];
    const attestPerson = useMemo(() => personRows.find(p => p.user_id === attestFor) || null, [personRows, attestFor]);

    // An action column carries no header label — nothing to translate, no empty key.
    const personColumns = PERSON_COLUMNS.map(c => ({ ...c, label: c.label ? t(c.label, PERSON_FALLBACKS[c.id]) : '' }));
    const oblColumns = OBL_COLUMNS.map(c => ({ ...c, label: c.label ? t(c.label, OBL_FALLBACKS[c.id]) : '' }));

    const submitAttest = async () => {
        if (!attestPerson) return;
        await state.attest?.(attestPerson.user_id, note.trim() || undefined);
        setAttestFor(null);
        setNote('');
    };

    const submitCreate = async () => {
        if (!draft.title.trim() || !draft.due_at) return;
        await state.createObligation?.({
            kind: draft.kind,
            subject: draft.subject.trim() || undefined,
            title: draft.title.trim(),
            due_at: draft.due_at,
            recur_months: draft.recur_months ? Number(draft.recur_months) : undefined,
            owner_user_id: draft.owner_user_id || undefined,
        });
        setDraft(EMPTY_DRAFT);
        setCreating(false);
    };

    const drawer = creating ? (
        <SideDrawer
            open
            onClose={() => setCreating(false)}
            mode={isMobile ? 'modal' : 'inline'}
            width={380}
            ariaLabel={t('compliance.obl_add', 'Add obligation')}
            testId="obligation-drawer"
            header={<span className="text-sm font-bold text-[var(--text-primary)]">{t('compliance.obl_add', 'Add obligation')}</span>}
            footer={(
                <div className="flex items-center gap-2">
                    <ActionButton variant="primary" disabled={!draft.title.trim() || !draft.due_at} onClick={submitCreate} data-testid="obligation-create-submit">
                        {t('compliance.obl_create', 'Add to the clock')}
                    </ActionButton>
                    <ActionButton onClick={() => setCreating(false)} data-testid="obligation-create-cancel">
                        {t('common.cancel', 'Cancel')}
                    </ActionButton>
                </div>
            )}
        >
            <DrawerSection label={t('compliance.obl_f_kind', 'Kind')}>
                <Select
                    value={draft.kind}
                    onChange={v => setDraft(d => ({ ...d, kind: v }))}
                    options={Object.entries(OBLIGATION_KINDS).map(([k, v]) => ({ value: k, label: t(v.key, v.en) }))}
                    data-testid="obligation-f-kind"
                />
            </DrawerSection>
            <DrawerSection label={t('compliance.obl_f_title', 'Title')}>
                <TextInput value={draft.title} autoFocus onChange={v => setDraft(d => ({ ...d, title: v }))} data-testid="obligation-f-title" />
            </DrawerSection>
            <DrawerSection label={t('compliance.obl_f_subject', 'Subject')}>
                <TextInput value={draft.subject} onChange={v => setDraft(d => ({ ...d, subject: v }))} data-testid="obligation-f-subject" />
            </DrawerSection>
            <div className="grid grid-cols-2 gap-3">
                <Field label={t('compliance.obl_f_due', 'Due date')}>
                    <DateInput value={draft.due_at} onChange={v => setDraft(d => ({ ...d, due_at: v }))} data-testid="obligation-f-due" />
                </Field>
                <Field label={t('compliance.obl_f_recur', 'Repeat (months)')} hint={t('compliance.obl_recur_hint', 'Leave empty for a one-off')}>
                    <TextInput type="number" min={0} max={120} value={draft.recur_months} onChange={v => setDraft(d => ({ ...d, recur_months: v }))} data-testid="obligation-f-recur" />
                </Field>
            </div>
            <DrawerSection label={t('compliance.obl_f_owner', 'Owner')}>
                <UserSelect
                    value={draft.owner_user_id}
                    orgUsers={orgUsers}
                    noneLabel={t('compliance.obl_owner_none', 'No owner')}
                    onChange={v => setDraft(d => ({ ...d, owner_user_id: v }))}
                    data-testid="obligation-f-owner"
                />
            </DrawerSection>
        </SideDrawer>
    ) : (attestPerson && (
        <SideDrawer
            open
            onClose={() => { setAttestFor(null); setNote(''); }}
            mode={isMobile ? 'modal' : 'inline'}
            width={380}
            ariaLabel={t('compliance.training_attest', 'Record training')}
            testId="attest-drawer"
            header={(
                <div className="flex flex-col gap-0.5 min-w-0">
                    <span className="text-sm font-bold text-[var(--text-primary)] truncate">{attestPerson.displayName || maskEmail(attestPerson.email)}</span>
                    <span className="text-[11px] text-[var(--text-tertiary)] truncate">{maskEmail(attestPerson.email)}</span>
                </div>
            )}
            footer={(
                <div className="flex items-center gap-2">
                    <ActionButton variant="primary" icon={CheckCircle2} disabled={state.busyId === attestPerson.user_id} onClick={submitAttest} data-testid="attest-submit">
                        {t('compliance.training_attest_confirm', 'Record attestation')}
                    </ActionButton>
                    <ActionButton onClick={() => { setAttestFor(null); setNote(''); }} data-testid="attest-cancel">
                        {t('common.cancel', 'Cancel')}
                    </ActionButton>
                </div>
            )}
        >
            <DrawerSection label={t('compliance.training_attest_note', 'Note')} hint={t('compliance.training_attest_hint', 'Which training, given when and by whom — this is your record, not ours.')}>
                <TextInput value={note} autoFocus onChange={setNote} placeholder={t('compliance.training_attest_note_ph', 'Security awareness, 12 Sep, external trainer')} data-testid="attest-note" />
            </DrawerSection>
            {attestPerson.attested_at && (
                <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="attest-previous">
                    {t('compliance.training_attested_at', 'Training attested {date}', { date: fmtDate(attestPerson.attested_at) })}
                    {attestPerson.attested_note ? ` · ${attestPerson.attested_note}` : ''}
                </div>
            )}
        </SideDrawer>
    ));

    return (
        <RegisterLayout
            isMobile={isMobile}
            testId="training-page"
            drawer={drawer}
            toolbar={(
                <>
                    <Intro testId="training-intro">
                        {t('compliance.training_intro', 'Who acknowledged which policy, who was trained, and what the ISMS owes itself next.')}
                    </Intro>
                    <ActionButton variant="primary" icon={Plus} onClick={() => { setAttestFor(null); setCreating(true); }} data-testid="obligation-add">
                        {t('compliance.obl_add', 'Add obligation')}
                    </ActionButton>
                </>
            )}
        >
            <section className="flex flex-col gap-2" data-testid="training-personnel">
                <h3 className="m-0 text-xs font-bold text-[var(--text-primary)] flex items-center gap-1.5">
                    <GraduationCap size={13} aria-hidden="true" />
                    {t('compliance.training_personnel_title', 'People')}
                </h3>
                {personnelFailed ? (
                    <ReadFailed testId="training-personnel-failed">
                        {t('compliance.training_personnel_failed', 'The personnel list could not be read.')}
                    </ReadFailed>
                ) : (
                    <DataTable
                        columns={personColumns}
                        rows={personRows}
                        rowKey={(p) => p.user_id}
                        loading={personnelLoading}
                        isMobile={isMobile}
                        ariaLabel={t('compliance.training_personnel_title', 'People')}
                        testId="training-personnel-table"
                        empty={<EmptyState title={t('compliance.training_no_personnel', 'No members in this organisation yet')} />}
                        renderCard={(p) => {
                            // Counts the server did not state render nothing (never "0 / 0").
                            const known = p.policy_acks != null && p.policy_total != null;
                            const acked = p.policy_acks;
                            const total = p.policy_total;
                            const full = known && total > 0 && acked >= total;
                            const dueAt = attestationDueAt(p);
                            return (
                                <div className="w-full min-w-0 flex items-center gap-2" data-testid={`training-person-card-${p.user_id}`}>
                                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                                        <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{p.displayName || maskEmail(p.email)}</span>
                                        <span className="text-[11px] text-[var(--text-tertiary)] truncate">{maskEmail(p.email)}</span>
                                        <span className="flex items-center gap-2 min-w-0 text-[11px]">
                                            {known && (
                                                <StatusPill tone={full ? 'success' : (total > 0 ? 'warning' : 'neutral')} testId={`training-acks-card-${p.user_id}`}>
                                                    {`${acked} / ${total}`}
                                                </StatusPill>
                                            )}
                                            {dueAt
                                                ? <DeadlineClock dueAt={dueAt} startedAt={p.attested_at} variant="inline" testId={`training-clock-card-${p.user_id}`} />
                                                : <span className="text-[var(--text-tertiary)] truncate" data-testid={`training-never-card-${p.user_id}`}>{t('compliance.training_never_attested', 'Never attested')}</span>}
                                        </span>
                                    </div>
                                    <ActionButton
                                        icon={GraduationCap}
                                        disabled={state.busyId === p.user_id}
                                        onClick={() => { setCreating(false); setNote(''); setAttestFor(p.user_id); }}
                                        className="flex-shrink-0 min-h-[44px]"
                                        data-testid={`training-attest-card-${p.user_id}`}
                                    >
                                        {p.attested_at ? t('compliance.training_reattest', 'Record again') : t('compliance.training_attest', 'Record training')}
                                    </ActionButton>
                                </div>
                            );
                        }}
                        renderRow={(p, ctx) => {
                            // Both counts or neither: `?? 0` used to print "0 / 0" for a
                            // person the server said nothing about, which reads as "this
                            // person has acknowledged nothing" rather than "we don't know".
                            // The phone card (renderCard, above) already does it this way.
                            const known = typeof p.policy_acks === 'number' && typeof p.policy_total === 'number';
                            const acked = known ? p.policy_acks : null;
                            const total = known ? p.policy_total : null;
                            const full = known && total > 0 && acked >= total;
                            const dueAt = attestationDueAt(p);
                            return (
                                <TableRow columns={ctx.columns} accent={full ? 'success' : (known && total > 0 ? 'warning' : 'neutral')} testId={`training-person-${p.user_id}`}>
                                    <TableCell column={ctx.columns[0]}>
                                        <span className="flex flex-col min-w-0">
                                            <span className="font-semibold text-[var(--text-primary)] truncate">{p.displayName || maskEmail(p.email)}</span>
                                            <span className="text-[11px] text-[var(--text-tertiary)] truncate" data-testid={`training-email-${p.user_id}`}>{maskEmail(p.email)}</span>
                                        </span>
                                    </TableCell>
                                    <TableCell column={ctx.columns[1]}>
                                        {known ? (
                                            <StatusPill tone={full ? 'success' : (total > 0 ? 'warning' : 'neutral')} testId={`training-acks-${p.user_id}`}>
                                                {`${acked} / ${total}`}
                                            </StatusPill>
                                        ) : <span className="text-[var(--text-tertiary)]">—</span>}
                                    </TableCell>
                                    <TableCell column={ctx.columns[2]}>
                                        {p.learning_done != null
                                            ? <span className="text-[var(--text-secondary)] tabular-nums" data-testid={`training-learning-${p.user_id}`}>{p.learning_done}</span>
                                            : <span className="text-[var(--text-tertiary)]">—</span>}
                                    </TableCell>
                                    <TableCell column={ctx.columns[3]}>
                                        {dueAt
                                            ? <DeadlineClock dueAt={dueAt} startedAt={p.attested_at} variant="inline" testId={`training-clock-${p.user_id}`} />
                                            : <span className="text-[var(--text-tertiary)]" data-testid={`training-never-${p.user_id}`}>{t('compliance.training_never_attested', 'Never attested')}</span>}
                                    </TableCell>
                                    <TableCell column={ctx.columns[4]}>
                                        <ActionButton
                                            size="sm"
                                            icon={GraduationCap}
                                            disabled={state.busyId === p.user_id}
                                            onClick={() => { setCreating(false); setNote(''); setAttestFor(p.user_id); }}
                                            data-testid={`training-attest-${p.user_id}`}
                                        >
                                            {p.attested_at ? t('compliance.training_reattest', 'Record again') : t('compliance.training_attest', 'Record training')}
                                        </ActionButton>
                                    </TableCell>
                                </TableRow>
                            );
                        }}
                    />
                )}
            </section>

            <section className="flex flex-col gap-2" data-testid="training-obligations">
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
                                description={t('compliance.obl_empty', 'Add the reviews, audits and trainings your ISMS owes itself; recurring ones roll forward when you complete them.')}
                            />
                        )}
                        renderCard={(o) => {
                            const done = !!o.completed_at;
                            return (
                                <div className="w-full min-w-0 flex items-center gap-2" data-testid={`obligation-card-${o.id}`}>
                                    <div className="flex-1 min-w-0 flex flex-col gap-1">
                                        <span className="flex items-center gap-2 min-w-0">
                                            <StatusPill tone="neutral" testId={`obligation-kind-card-${o.id}`}>{labelOf(t, OBLIGATION_KINDS, o.kind)}</StatusPill>
                                            <span className="text-xs font-semibold text-[var(--text-primary)] truncate">{o.title}</span>
                                        </span>
                                        <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                            {o.subject ? `${o.subject} · ` : ''}
                                            {o.recur_months
                                                ? <span className="inline-flex items-center gap-1"><Repeat size={10} aria-hidden="true" />{t('compliance.obl_recur_every', 'every {months} months', { months: o.recur_months })}</span>
                                                : null}
                                            {userName(orgUsers, o.owner_user_id) ? ` · ${userName(orgUsers, o.owner_user_id)}` : ''}
                                        </span>
                                        <DeadlineClock dueAt={o.due_at} doneAt={o.completed_at} variant="inline" testId={`obligation-clock-card-${o.id}`} />
                                    </div>
                                    {done ? (
                                        <span className="text-[11px] text-[var(--success-ink)] inline-flex items-center gap-1 flex-shrink-0" data-testid={`obligation-done-card-${o.id}`}>
                                            <CheckCircle2 size={11} aria-hidden="true" />
                                            {t('compliance.obl_completed_at', 'Done {date}', { date: fmtDate(o.completed_at) })}
                                        </span>
                                    ) : (
                                        <ActionButton
                                            variant="success"
                                            icon={CheckCircle2}
                                            disabled={state.busyId === o.id}
                                            onClick={() => state.completeObligation?.(o.id)}
                                            className="flex-shrink-0 min-h-[44px]"
                                            data-testid={`obligation-complete-card-${o.id}`}
                                        >
                                            {t('compliance.obl_complete', 'Complete')}
                                        </ActionButton>
                                    )}
                                </div>
                            );
                        }}
                        renderRow={(o, ctx) => {
                            const done = !!o.completed_at;
                            return (
                                <TableRow columns={ctx.columns} accent={done ? 'success' : null} testId={`obligation-row-${o.id}`}>
                                    <TableCell column={ctx.columns[0]}>
                                        <StatusPill tone="neutral" testId={`obligation-kind-${o.id}`}>{labelOf(t, OBLIGATION_KINDS, o.kind)}</StatusPill>
                                    </TableCell>
                                    <TableCell column={ctx.columns[1]}>
                                        <span className="flex flex-col min-w-0">
                                            <span className="font-semibold text-[var(--text-primary)] truncate">{o.title}</span>
                                            <span className="text-[11px] text-[var(--text-tertiary)] truncate">
                                                {o.subject ? `${o.subject} · ` : ''}
                                                {o.recur_months
                                                    ? <span className="inline-flex items-center gap-1"><Repeat size={10} aria-hidden="true" />{t('compliance.obl_recur_every', 'every {months} months', { months: o.recur_months })}</span>
                                                    : null}
                                            </span>
                                        </span>
                                    </TableCell>
                                    <TableCell column={ctx.columns[2]}>
                                        <DeadlineClock dueAt={o.due_at} doneAt={o.completed_at} variant="inline" testId={`obligation-clock-${o.id}`} />
                                    </TableCell>
                                    <TableCell column={ctx.columns[3]}>
                                        <span className="truncate text-[var(--text-secondary)]">{userName(orgUsers, o.owner_user_id) || '—'}</span>
                                    </TableCell>
                                    <TableCell column={ctx.columns[4]}>
                                        {done ? (
                                            <span className="text-[11px] text-[var(--success-ink)] inline-flex items-center gap-1" data-testid={`obligation-done-${o.id}`}>
                                                <CheckCircle2 size={11} aria-hidden="true" />
                                                {t('compliance.obl_completed_at', 'Done {date}', { date: fmtDate(o.completed_at) })}
                                            </span>
                                        ) : (
                                            <ActionButton
                                                size="sm"
                                                variant="success"
                                                icon={CheckCircle2}
                                                disabled={state.busyId === o.id}
                                                onClick={() => state.completeObligation?.(o.id)}
                                                data-testid={`obligation-complete-${o.id}`}
                                            >
                                                {t('compliance.obl_complete', 'Complete')}
                                            </ActionButton>
                                        )}
                                    </TableCell>
                                </TableRow>
                            );
                        }}
                    />
                )}
            </section>
        </RegisterLayout>
    );
}
