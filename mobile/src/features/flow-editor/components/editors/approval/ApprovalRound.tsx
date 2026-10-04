/**
 * One round of approval — the web's single approver, panel, decision rule and
 * final sign-off (approvalEditors.jsx). One picker value encodes a seat: ''
 * (the owner, or nobody), `u:<id>`, `g:<id>`. The clocks every approval has
 * are ApprovalClocks.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { ApprovalDirectory } from '@/features/flow-editor/api';
import { FieldRow, SelectField } from '@/features/flow-editor/components/fields';
import type { FormDraft } from '@/features/flow-editor/formState';
import { Button, Icon, IconButton } from '@/shared/ui';

import { decodeSeat, directoryOptions, MAX_PANEL_SEATS, seatValue, startPanel, type Seat } from './approvalModel';
import { QuorumSelect } from './QuorumSelect';
import { RuleSelect } from './RuleSelect';
import { AddButton } from '../shared/AddButton';
import { removeAt } from '../shared/list';
import { Note } from '../shared/Note';

export interface RoundProps {
    draft: FormDraft;
    setMany: (patch: FormDraft) => void;
    directory: ApprovalDirectory | null;
    disabled: boolean;
}

function Panel({ draft, setMany, directory, disabled }: RoundProps) {
    const t = useTranslation();
    const seats = (Array.isArray(draft.approvers) ? draft.approvers : []) as Seat[];
    const real = seats.filter((s) => s && (s.userId || s.groupId)).length;
    const options = [{ value: '', label: t('automations.builder.approval_pick_seat', '— pick a person or group —') }, ...directoryOptions(directory, t('mobile.flow.approval.groups', 'Groups'))];
    const rule = typeof draft.rule === 'string' && draft.rule ? draft.rule : 'all';
    return (
        <>
            <FieldRow
                label={t('automations.versions.setting.approvers', 'Approvers')}
                hint={t('mobile.flow.approval.approvers_hint', 'Up to 10 seats — a person, or a group whose first voting member fills the seat. How the votes resolve is set below. Remove every seat to go back to a single approver.')}
            >
                {seats.map((seat, i) => (
                    <FieldRow
                        key={i}
                        accessory={
                            disabled ? null : (
                                <IconButton
                                    icon={<Icon name="X" size={14} />}
                                    onPress={() => setMany({ approvers: removeAt(seats, i) })}
                                    accessibilityLabel={t('mobile.flow.approval.remove_seat', 'Remove approver seat {n}', { n: i + 1 })}
                                />
                            )
                        }
                    >
                        <SelectField
                            label={t('mobile.flow.approval.seat', 'Approver seat {n}', { n: i + 1 })}
                            value={seatValue(seat)}
                            options={options}
                            onChange={(v) => setMany({ approvers: seats.map((s, j) => (j === i ? decodeSeat(v) : s)) })}
                            disabled={disabled}
                        />
                    </FieldRow>
                ))}
                {seats.length < MAX_PANEL_SEATS ? <AddButton label={t('automations.builder.approval_stage_seat_add', 'Add approver')} onPress={() => setMany({ approvers: [...seats, null] })} disabled={disabled} /> : null}
            </FieldRow>
            {real >= 2 ? (
                <FieldRow
                    label={t('mobile.flow.approval.decision_rule', 'Decision rule')}
                    hint={t('mobile.flow.approval.decision_rule_hint', 'How the votes become one answer. With “everyone”, one reject declines immediately — the requester hears fast.')}
                >
                    <RuleSelect value={rule} onChange={(r) => setMany({ rule: r })} disabled={disabled} />
                    {rule === 'quorum' ? <QuorumSelect value={draft.quorum} seats={real} onChange={(quorum) => setMany({ quorum })} disabled={disabled} /> : null}
                </FieldRow>
            ) : null}
        </>
    );
}

/** Who decides, in one round: a person or group (or the owner), or a panel; then an optional final sign-off. */
export function ApprovalRound(props: RoundProps & { onUseStages: () => void }) {
    const t = useTranslation();
    const { draft, setMany, directory, disabled } = props;
    const panel = Array.isArray(draft.approvers) && draft.approvers.length > 0;
    const people = directoryOptions(directory, t('mobile.flow.approval.groups', 'Groups'));
    return (
        <>
            {panel ? (
                <Panel {...props} />
            ) : (
                <>
                    <SelectField
                        label={t('mobile.flow.approval.who_decides', 'Who decides')}
                        hint={t('mobile.flow.approval.who_decides_hint', 'A person or group in your organisation. They get the notification; the first decision wins. Leave empty and you decide.')}
                        value={seatValue(draft.assignee)}
                        options={[{ value: '', label: t('mobile.flow.approval.me', 'Me (the owner)') }, ...people]}
                        onChange={(v) => setMany({ assignee: decodeSeat(v) })}
                        disabled={disabled}
                        testID="approval-assignee"
                    />
                    <Button size="sm" variant="ghost" iconName="Plus" label={t('mobile.flow.approval.more_approvers', 'More approvers')} onPress={() => setMany(startPanel(draft))} disabled={disabled} testID="approval-more" />
                </>
            )}
            <SelectField
                label={t('automations.builder.approval_final_stage_name', 'Final sign-off')}
                hint={t('mobile.flow.approval.final_signoff_hint', 'Optional second stage: once the approver(s) say yes, this person or group has the last word — only then does the run continue.')}
                value={seatValue(draft.finalApprover)}
                options={[{ value: '', label: t('mobile.flow.approval.no_final', 'No final sign-off') }, ...people]}
                onChange={(v) => setMany({ finalApprover: decodeSeat(v) })}
                disabled={disabled}
            />
            <Note>{t('automations.builder.approval_stages_intro', 'Need more than two rounds? Ask several groups in turn — each stage has its own approvers, its own rule and its own name.')}</Note>
            <Button size="sm" variant="secondary" iconName="Workflow" label={t('automations.builder.approval_use_stages', 'Use approval stages')} onPress={props.onUseStages} disabled={disabled} testID="approval-use-stages" />
        </>
    );
}
