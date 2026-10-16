import { useTranslation } from '../../../../../hooks/useTranslation';
import { controlSurfaceClass, FormRow } from './formPrimitives';
import { DirectoryOptions } from './approvalStages';
import { seatFromSelectValue, seatSelectValue } from './approvalTypes';
import type { ApprovalDirectory, ApprovalDraft, SetDraft } from './approvalTypes';

/**
 * How long an approval may sit before the run is closed as expired.
 *
 * Offered as choices rather than a number box because "how long should a person
 * have?" is a business decision with a handful of sensible answers, not an
 * arithmetic one — and because the two ends of the range are the ones that
 * matter: a same-day gate, and no deadline at all. `0` is a real value here,
 * not an empty one: the engine reads it as "never expire".
 *
 * The bound (720h / 30 days) mirrors the engine's own ceiling, so a choice
 * offered here is always a choice the run will honour.
 */
const APPROVAL_DEADLINE_CHOICES = [
    { value: 4, label: '4 hours' },
    { value: 24, label: '1 day' },
    { value: 72, label: '3 days' },
    { value: 168, label: '7 days' },
    { value: 336, label: '14 days' },
    { value: 720, label: '30 days' },
    { value: 0, label: 'No deadline' },
];

// Reminder / escalation delays — shorter horizons than the deadline list, and
// no zero: both clocks are opt-in ('' = off), unlike the deadline.
const APPROVAL_CLOCK_CHOICES = [
    { value: 1, label: '1 hour' },
    { value: 4, label: '4 hours' },
    { value: 24, label: '1 day' },
    { value: 48, label: '2 days' },
    { value: 72, label: '3 days' },
    { value: 168, label: '7 days' },
];

interface ApprovalClocksProps {
    draft: ApprovalDraft;
    set: SetDraft;
    directory: ApprovalDirectory | null;
    /** Escalation is a legacy-mode field: not offered with stages or an approver panel. */
    showEscalation: boolean;
}

/** The three clocks of an approval: the deadline, the reminder and the escalation. */
export function ApprovalClockFields({ draft, set, directory, showEscalation }: ApprovalClocksProps) {
    const { t } = useTranslation();
    const hours = Number.isFinite(Number(draft.expiresInHours)) ? Number(draft.expiresInHours) : 168;
    const choices = APPROVAL_DEADLINE_CHOICES.some(c => c.value === hours)
        ? APPROVAL_DEADLINE_CHOICES
        : [...APPROVAL_DEADLINE_CHOICES, { value: hours, label: `${hours} hours` }];
    return (
        <>
            <FormRow
                label={t('automations.approval_editors.decide_within', 'Decide within')}
                hint={'If nobody decides in time, the run is closed as expired. Pick "No deadline" to let it wait as long as it needs.'}
            >
                <select
                    value={String(hours)}
                    onChange={(e) => set('expiresInHours', Number(e.target.value))}
                    className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                    aria-label={t('automations.approval_editors.approval_deadline', 'Approval deadline')}
                >
                    {choices.map(c => (
                        <option key={c.value} value={String(c.value)}>{c.label}</option>
                    ))}
                </select>
            </FormRow>
            <FormRow
                label={t('automations.approval_editors.remind_after', 'Remind after')}
                hint={t('automations.approval_editors.nudge_the_approver_again_if_nobody', 'Nudge the approver again if nobody has decided by then. Must be earlier than the deadline.')}
            >
                <select
                    value={String(draft.remindAfterHours || '')}
                    onChange={(e) => set('remindAfterHours', e.target.value ? Number(e.target.value) : '')}
                    className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                    aria-label={t('automations.approval_editors.reminder_delay', 'Reminder delay')}
                >
                    <option value="">{t('automations.approval_editors.no_reminder', 'No reminder')}</option>
                    {APPROVAL_CLOCK_CHOICES.map(c => (
                        <option key={c.value} value={String(c.value)}>{c.label}</option>
                    ))}
                </select>
            </FormRow>
            {showEscalation && (
                <FormRow
                    label={t('automations.approval_editors.escalate_to', 'Escalate to')}
                    hint={t('automations.approval_editors.if_nobody_decides_this_person_or', 'If nobody decides, this person or group ALSO gains the right to decide — the original approver keeps theirs.')}
                >
                    <div className="flex items-center gap-2">
                        <select
                            value={seatSelectValue(draft.escalateTo)}
                            onChange={(e) => {
                                const v = e.target.value;
                                if (!v) { set('escalateTo', null); set('escalateAfterHours', ''); return; }
                                set('escalateTo', seatFromSelectValue(v));
                                if (!draft.escalateAfterHours) set('escalateAfterHours', 24);
                            }}
                            className={controlSurfaceClass('px-2 py-1.5 text-sm flex-1')}
                            aria-label={t('automations.approval_editors.escalate_to', 'Escalate to')}
                        >
                            <option value="">{t('automations.approval_editors.no_escalation', 'No escalation')}</option>
                            <DirectoryOptions directory={directory} />
                        </select>
                        {(draft.escalateTo?.userId || draft.escalateTo?.groupId) && (
                            <select
                                value={String(draft.escalateAfterHours || 24)}
                                onChange={(e) => set('escalateAfterHours', Number(e.target.value))}
                                className={controlSurfaceClass('px-2 py-1.5 text-sm')}
                                aria-label={t('automations.approval_editors.escalation_delay', 'Escalation delay')}
                            >
                                {APPROVAL_CLOCK_CHOICES.map(c => (
                                    <option key={c.value} value={String(c.value)}>{`after ${c.label}`}</option>
                                ))}
                            </select>
                        )}
                    </div>
                </FormRow>
            )}
        </>
    );
}
