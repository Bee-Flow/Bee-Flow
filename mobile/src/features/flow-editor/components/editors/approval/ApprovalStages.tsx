/**
 * The sequential approval chain — the web's ApprovalStagesEditor and StageRow
 * (approvalStages.jsx): up to five named stages asked one after another, each
 * with its own approvers, rule and optional condition. The invariant is the
 * stage KEY — votes are filed under it — so every edit moves the stage OBJECT
 * (its key rides along) and only "Add stage" mints one.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import type { ApprovalDirectory } from '@/features/flow-editor/api';
import { FieldRow, SelectField } from '@/features/flow-editor/components/fields';
import { MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_STAGE_DESCRIPTION_LEN, MAX_STAGE_NAME_LEN, MAX_TOTAL_STAGE_SEATS, STAGE_RULES, stageSeats, totalStageSeats } from '@/features/flow-editor/formState';
import { Button, Icon, IconButton, Text, TextField } from '@/shared/ui';

import { addStage, decodeSeat, directoryOptions, seatValue, type Stage } from './approvalModel';
import { QuorumSelect } from './QuorumSelect';
import { RuleSelect } from './RuleSelect';
import { ConditionBuilder } from '../route/ConditionBuilder';
import type { FieldOption } from '../route/fieldOptions';
import { AddButton } from '../shared/AddButton';
import { moveAt, patchAt, removeAt } from '../shared/list';
import { Note } from '../shared/Note';
import { RowCard } from '../shared/RowCard';
import { Warn } from '../shared/Warn';

interface Shared {
    directory: ApprovalDirectory | null;
    sampleRoot: unknown;
    fieldOptions: readonly FieldOption[];
    disabled: boolean;
}

function StageWhen({ stage, onPatch, shared }: { stage: Stage; onPatch: (p: Partial<Stage>) => void; shared: Shared }) {
    const t = useTranslation();
    const hasWhen = typeof stage.when === 'string' && stage.when.length > 0;
    const [show, setShow] = useState(false);
    if (!show && !hasWhen) {
        return <Button size="sm" variant="ghost" iconName="Plus" label={t('automations.builder.approval_stage_when_add', 'Only ask this stage when…')} onPress={() => setShow(true)} disabled={shared.disabled} />;
    }
    return (
        <>
            <Text variant="label" tone="tertiary">
                {t('automations.builder.approval_stage_when_label', 'Only ask this stage when')}
            </Text>
            <ConditionBuilder value={stage.when || ''} onChange={(when) => onPatch({ when })} sampleRoot={shared.sampleRoot} fieldOptions={shared.fieldOptions} fieldBase="trigger.output" disabled={shared.disabled} />
            <Button
                size="sm"
                variant="ghost"
                label={t('automations.builder.approval_stage_when_clear', 'Always ask it')}
                onPress={() => {
                    setShow(false);
                    onPatch({ when: '' });
                }}
                disabled={shared.disabled}
            />
            <Note>{t('automations.builder.approval_stage_when_hint', "Checked once, the moment the approval is created. A stage whose condition is not met is skipped — the chain moves straight on, and the skip stays visible in the approval's history.")}</Note>
        </>
    );
}

interface StageRowProps {
    stage: Stage;
    index: number;
    total: number;
    budgetLeft: number;
    onPatch: (p: Partial<Stage>) => void;
    onMove: ((dir: -1 | 1) => void) | null;
    onRemove: () => void;
    shared: Shared;
}

function StageRow({ stage, index, total, budgetLeft, onPatch, onMove, onRemove, shared }: StageRowProps) {
    const t = useTranslation();
    const n = String(index + 1);
    const seats = Array.isArray(stage.approvers) ? stage.approvers : [];
    const picked = stageSeats(stage);
    const rule = STAGE_RULES.includes(stage.rule as string) ? (stage.rule as string) : 'all';
    const options = directoryOptions(shared.directory, t('mobile.flow.approval.groups', 'Groups'));
    return (
        <RowCard
            title={t('automations.builder.approval_stage_position', 'Stage {n} of {m}', { n, m: String(total) })}
            onMoveUp={onMove && index > 0 ? () => onMove(-1) : null}
            onMoveDown={onMove && index < total - 1 ? () => onMove(1) : null}
            onRemove={onRemove}
            removeLabel={t('automations.builder.approval_stage_remove', 'Remove stage {n}', { n })}
            disabled={shared.disabled}
            testID={`approval-stage-${n}`}
        >
            <TextField
                value={typeof stage.name === 'string' ? stage.name : ''}
                maxLength={MAX_STAGE_NAME_LEN}
                onChangeText={(name) => onPatch({ name })}
                placeholder={t('automations.builder.approval_stage_name_ph', 'Name this stage — Team lead, Finance…')}
                accessibilityLabel={t('automations.builder.approval_stage_name_aria', 'Name of stage {n}', { n })}
                editable={!shared.disabled}
            />
            <TextField
                value={typeof stage.description === 'string' ? stage.description : ''}
                maxLength={MAX_STAGE_DESCRIPTION_LEN}
                onChangeText={(description) => onPatch({ description })}
                placeholder={t('automations.builder.approval_stage_desc_ph', 'What are these approvers checking? (optional)')}
                accessibilityLabel={t('automations.builder.approval_stage_desc_aria', 'Description of stage {n}', { n })}
                editable={!shared.disabled}
            />
            {seats.map((seat, si) => (
                <FieldRow
                    key={si}
                    accessory={
                        seats.length > 1 && !shared.disabled ? (
                            <IconButton
                                icon={<Icon name="X" size={14} />}
                                onPress={() => onPatch({ approvers: removeAt(seats, si) })}
                                accessibilityLabel={t('automations.builder.approval_stage_seat_remove', 'Remove approver {s} from stage {n}', { n, s: String(si + 1) })}
                            />
                        ) : null
                    }
                >
                    <SelectField
                        value={seatValue(seat)}
                        options={[{ value: '', label: t('automations.builder.approval_pick_seat', '— pick a person or group —') }, ...options]}
                        onChange={(v) => onPatch({ approvers: seats.map((s, idx) => (idx === si ? decodeSeat(v) : s)) })}
                        label={t('automations.builder.approval_stage_seat_aria', 'Stage {n}, approver {s}', { n, s: String(si + 1) })}
                        disabled={shared.disabled}
                    />
                </FieldRow>
            ))}
            {seats.length < MAX_SEATS_PER_STAGE && budgetLeft > 0 ? (
                <AddButton label={t('automations.builder.approval_stage_seat_add', 'Add approver')} onPress={() => onPatch({ approvers: [...seats, null] })} disabled={shared.disabled} />
            ) : null}
            {picked.length === 0 ? <Warn tone="error">{t('automations.builder.approval_stage_empty', 'Pick at least one approver — a stage with nobody in it is not saved.')}</Warn> : null}
            {picked.length >= 2 ? (
                <>
                    <RuleSelect value={rule} onChange={(r) => onPatch({ rule: r })} label={t('automations.builder.approval_stage_rule_aria', 'Decision rule for stage {n}', { n })} disabled={shared.disabled} />
                    {rule === 'quorum' ? <QuorumSelect value={stage.quorum} seats={picked.length} onChange={(quorum) => onPatch({ quorum })} disabled={shared.disabled} /> : null}
                </>
            ) : null}
            <StageWhen stage={stage} onPatch={onPatch} shared={shared} />
        </RowCard>
    );
}

export function ApprovalStages({ stages, onChange, onDropStages, shared }: { stages: Stage[]; onChange: (next: Stage[]) => void; onDropStages: () => void; shared: Shared }) {
    const t = useTranslation();
    const used = totalStageSeats(stages);
    const budgetLeft = MAX_TOTAL_STAGE_SEATS - used;
    return (
        <FieldRow
            label={t('automations.builder.approval_stages_label', 'Approval stages')}
            hint={t('automations.builder.approval_stages_hint', "Up to 5 named steps, asked one after another. Only the current stage's people are asked, and only when their turn arrives — nobody further down the chain sees the request until it reaches them.")}
        >
            {stages.map((stage, i) => (
                <StageRow
                    key={stage.key || `stage-${i}`}
                    stage={stage}
                    index={i}
                    total={stages.length}
                    budgetLeft={budgetLeft}
                    onPatch={(p) => onChange(patchAt(stages, i, p))}
                    onMove={(dir) => onChange(moveAt(stages, i, dir))}
                    // Dropping the last stage IS "no stages": back to the one-round shape.
                    onRemove={() => (stages.length > 1 ? onChange(removeAt(stages, i)) : onDropStages())}
                    shared={shared}
                />
            ))}
            {stages.length < MAX_APPROVAL_STAGES ? <AddButton label={t('automations.builder.approval_stage_add', 'Add stage')} onPress={() => onChange(addStage(stages))} disabled={shared.disabled} testID="approval-stage-add" /> : null}
            <Button size="sm" variant="ghost" label={t('automations.builder.approval_use_simple', 'Back to one round of approval')} onPress={onDropStages} disabled={shared.disabled} testID="approval-use-simple" />
            {budgetLeft <= 0 ? (
                <Warn tone="error">{t('automations.builder.approval_stage_budget_full', 'The chain is full at {max} approvers — remove one before adding another.', { max: String(MAX_TOTAL_STAGE_SEATS) })}</Warn>
            ) : (
                <Note>{t('automations.builder.approval_stage_budget', '{used} of {max} approvers used across the chain', { used: String(used), max: String(MAX_TOTAL_STAGE_SEATS) })}</Note>
            )}
        </FieldRow>
    );
}

export type { Shared as ApprovalShared };
