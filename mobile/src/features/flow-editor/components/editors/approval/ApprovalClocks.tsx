/**
 * The clocks every approval has (approvalEditors.jsx): the deadline, the
 * reminder, and the escalation — which a panel or a chain does not take.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { SelectField } from '@/features/flow-editor/components/fields';

import { chooseEscalation, CLOCK_CHOICES, deadlineChoices, directoryOptions, seatValue } from './approvalModel';
import { type RoundProps } from './ApprovalRound';
import { say } from '../declarative/runtime';

/** The deadline, the reminder and — for a single approver only — the escalation. */
export function ApprovalClocks({ draft, setMany, directory, disabled, escalation }: RoundProps & { escalation: boolean }) {
    const t = useTranslation();
    const { hours, choices } = deadlineChoices(draft.expiresInHours);
    const clock = CLOCK_CHOICES.map((c) => ({ value: String(c.value), label: say(t, c.label) }));
    const escalateTo = seatValue(draft.escalateTo);
    return (
        <>
            <SelectField
                label={t('automations.approval_editors.decide_within', 'Decide within')}
                hint={t('mobile.flow.approval.decide_within_hint', 'If nobody decides in time, the run is closed as expired. Pick "No deadline" to let it wait as long as it needs.')}
                value={String(hours)}
                options={choices.map((c) => ({ value: String(c.value), label: say(t, c.label) }))}
                onChange={(v) => setMany({ expiresInHours: Number(v) })}
                disabled={disabled}
                testID="approval-deadline"
            />
            <SelectField
                label={t('automations.approval_editors.remind_after', 'Remind after')}
                hint={t('automations.approval_editors.nudge_the_approver_again_if_nobody', 'Nudge the approver again if nobody has decided by then. Must be earlier than the deadline.')}
                value={String(draft.remindAfterHours || '')}
                options={[{ value: '', label: t('automations.approval_editors.no_reminder', 'No reminder') }, ...clock]}
                onChange={(v) => setMany({ remindAfterHours: v ? Number(v) : '' })}
                disabled={disabled}
            />
            {escalation ? (
                <>
                    <SelectField
                        label={t('automations.approval_editors.escalate_to', 'Escalate to')}
                        hint={t('automations.approval_editors.if_nobody_decides_this_person_or', 'If nobody decides, this person or group ALSO gains the right to decide — the original approver keeps theirs.')}
                        value={escalateTo}
                        options={[{ value: '', label: t('automations.approval_editors.no_escalation', 'No escalation') }, ...directoryOptions(directory, t('mobile.flow.approval.groups', 'Groups'))]}
                        onChange={(v) => setMany(chooseEscalation(draft, v))}
                        disabled={disabled}
                    />
                    {escalateTo ? (
                        <SelectField
                            value={String(draft.escalateAfterHours || 24)}
                            options={CLOCK_CHOICES.map((c) => ({ value: String(c.value), label: t('mobile.flow.approval.after', 'after {time}', { time: say(t, c.label) }) }))}
                            onChange={(v) => setMany({ escalateAfterHours: Number(v) })}
                            disabled={disabled}
                        />
                    ) : null}
                </>
            ) : null}
        </>
    );
}
