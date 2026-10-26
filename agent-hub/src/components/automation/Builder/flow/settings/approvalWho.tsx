import { Workflow, X } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { DirectoryOptions } from './approvalStages';
import { actionButtonClass, controlSurfaceClass, FormRow, hintTextClass } from './formPrimitives';
import { seatFromSelectValue, seatSelectValue } from './approvalTypes';
import type { ApprovalDirectory, ApprovalDraft, SeatSlot, SetDraft } from './approvalTypes';
import { withSeat } from './approvalState';

interface ApprovalWhoProps {
    draft: ApprovalDraft;
    set: SetDraft;
    directory: ApprovalDirectory | null;
    panelSeats: SeatSlot[];
    panelActive: boolean;
    onUseStages: () => void;
}

/**
 * Who decides, outside stage mode: the single approver, the approver panel with
 * its decision rule, the final sign-off, and the door into approval stages.
 * Rendered only while no stages are active.
 */
export function ApprovalWhoFields({ draft, set, directory, panelSeats, panelActive, onUseStages }: ApprovalWhoProps) {
    const { t } = useTranslation();
    // One <select> encodes the three assignee states: '' (owner), 'u:<id>',
    // 'g:<id>' — decoded back into the persisted { userId } | { groupId }.
    const onAssignee = (e: { target: { value: string } }) => set('assignee', seatFromSelectValue(e.target.value));
    const realSeatCount = panelSeats.filter(seat => seat && (seat.userId || seat.groupId)).length;
    return (
        <>
            {!panelActive && (
                <FormRow
                    label={t('automations.approval_editors.who_decides', 'Who decides')}
                    hint={t('automations.approval_editors.a_person_or_group_in_your', 'A person or group in your organisation. They get the notification; the first decision wins. Leave empty and you decide.')}
                >
                    <div className="flex items-center gap-2">
                        <select
                            value={seatSelectValue(draft.assignee)}
                            onChange={onAssignee}
                            className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                            aria-label={t('automations.approval_editors.who_decides', 'Who decides')}
                        >
                            <option value="">{t('automations.approval_editors.me_the_owner', 'Me (the owner)')}</option>
                            <DirectoryOptions directory={directory} />
                        </select>
                        <button
                            type="button"
                            onClick={() => {
                                // Seed the panel with the current approver so switching
                                // modes never silently discards a choice.
                                set('approvers', draft.assignee ? [draft.assignee, null] : [null]);
                                set('assignee', null);
                            }}
                            className="shrink-0 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                        >
                            {t('automations.approval_editors.more_approvers', '+ More approvers')}
                        </button>
                    </div>
                </FormRow>
            )}
            {panelActive && (
                <FormRow
                    label={t('automations.approval_editors.approvers', 'Approvers')}
                    hint={t('automations.approval_editors.up_to_10_seats_a_person', 'Up to 10 seats — a person, or a group whose first voting member fills the seat. How the votes resolve is set below. Remove every seat to go back to a single approver.')}
                >
                    <div className="space-y-1.5">
                        {panelSeats.map((seat, i) => (
                            <div key={i} className="flex items-center gap-2">
                                <select
                                    value={seatSelectValue(seat)}
                                    onChange={(e) => set('approvers', withSeat(panelSeats, i, e.target.value))}
                                    className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                                    aria-label={`Approver seat ${i + 1}`}
                                >
                                    <option value="">{t('automations.approval_editors.pick_a_person_or_group', '— pick a person or group —')}</option>
                                    <DirectoryOptions directory={directory} />
                                </select>
                                <button
                                    type="button"
                                    onClick={() => set('approvers', panelSeats.filter((_, idx) => idx !== i))}
                                    aria-label={`Remove approver seat ${i + 1}`}
                                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-600 transition"
                                >
                                    <X size={13} />
                                </button>
                            </div>
                        ))}
                        {panelSeats.length < 10 && (
                            <button
                                type="button"
                                onClick={() => set('approvers', [...panelSeats, null])}
                                className="text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] underline underline-offset-2 transition"
                            >
                                {t('automations.approval_editors.add_approver', '+ Add approver')}
                            </button>
                        )}
                    </div>
                </FormRow>
            )}
            {panelActive && realSeatCount >= 2 && (
                <FormRow
                    label={t('automations.approval_editors.decision_rule', 'Decision rule')}
                    hint={t('automations.approval_editors.how_the_votes_become_one_answer', 'How the votes become one answer. With “everyone”, one reject declines immediately — the requester hears fast.')}
                >
                    <div className="flex items-center gap-2">
                        <select
                            value={draft.rule || 'all'}
                            onChange={(e) => set('rule', e.target.value)}
                            className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                            aria-label={t('automations.approval_editors.decision_rule', 'Decision rule')}
                        >
                            <option value="all">{t('automations.approval_editors.everyone_must_approve', 'Everyone must approve')}</option>
                            <option value="first">{t('automations.approval_editors.first_to_respond_decides', 'First to respond decides')}</option>
                            <option value="quorum">{t('automations.approval_editors.at_least_n_approvals', 'At least N approvals')}</option>
                        </select>
                        {(draft.rule || 'all') === 'quorum' && (
                            <select
                                value={String(Math.min(Math.max(Number(draft.quorum) || 2, 1), realSeatCount))}
                                onChange={(e) => set('quorum', Number(e.target.value))}
                                className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                                aria-label={t('automations.approval_editors.approvals_needed', 'Approvals needed')}
                            >
                                {Array.from({ length: realSeatCount }, (_, i) => i + 1).map(n => (
                                    <option key={n} value={String(n)}>{`${n} of ${realSeatCount}`}</option>
                                ))}
                            </select>
                        )}
                    </div>
                </FormRow>
            )}
            <FormRow
                label={t('automations.approval_editors.final_sign_off', 'Final sign-off')}
                hint={t('automations.approval_editors.optional_second_stage_once_the_approver', 'Optional second stage: once the approver(s) say yes, this person or group has the last word — only then does the run continue.')}
            >
                <select
                    value={seatSelectValue(draft.finalApprover)}
                    onChange={(e) => set('finalApprover', seatFromSelectValue(e.target.value))}
                    className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                    aria-label={t('automations.approval_editors.final_sign_off', 'Final sign-off')}
                >
                    <option value="">{t('automations.approval_editors.no_final_sign_off', 'No final sign-off')}</option>
                    <DirectoryOptions directory={directory} />
                </select>
            </FormRow>
            <div className="rounded-md border border-[var(--border-subtle)] px-2 py-1.5 flex items-start justify-between gap-2">
                <p className={`${hintTextClass()} min-w-0`}>
                    {t('automations.builder.approval_stages_intro', 'Need more than two rounds? Ask several groups in turn — each stage has its own approvers, its own rule and its own name.')}
                </p>
                <button
                    type="button"
                    onClick={onUseStages}
                    className={`${actionButtonClass()} shrink-0`}
                >
                    <Workflow size={12} /> {t('automations.builder.approval_use_stages', 'Use approval stages')}
                </button>
            </div>
        </>
    );
}
