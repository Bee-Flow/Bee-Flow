import { ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import ExpressionInput from '@/components/admin/Studio/AppStudio/inspector/logic/ExpressionInput';
import { INPUT_CLS } from '@/components/admin/Studio/AppStudio/inspector/panels/kit';
import { DirectoryOptions } from '@/components/automation/Builder/flow/settings/approvalStages';
import { useApprovalDirectory } from '@/components/automation/Builder/flow/settings/approvalState';
import { seatFromSelectValue, seatSelectValue, type ApprovalDirectory } from '@/components/automation/Builder/flow/settings/approvalTypes';
import {
    MAX_APPROVAL_STAGES, MAX_SEATS_PER_STAGE, MAX_STAGE_DESCRIPTION_LEN, MAX_STAGE_NAME_LEN, MAX_TOTAL_STAGE_SEATS, newStageKey,
} from '@/components/automation/Builder/flow/settings/formState';
import { canonicalStages, withoutSupersededApprovers, type ApprovalStage, type Seat } from '../stepFieldShapes';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppAction } from '@/components/admin/Studio/AppStudio/inspector/appDefinition';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

/**
 * `approvalStages`: request_approval's ordered chain of up to five named stages, each with its own
 * approvers, rule and optional condition. It reuses the automation approval editor's pieces (the
 * organisation directory, the seat encoding, the stage key minting and the shared limits); the
 * condition is an App Studio formula, so it is the App Studio formula box, not the automation one.
 *
 * Every state it writes is one canonicalize keeps as it is (canonicalStages): a seat is added by
 * picking it, never as an empty row, and a stage is added by picking its first approver, so there
 * is never a stage nobody sits in (the server would drop it). Keys are minted once and travel with
 * their stage through moves: already-cast votes are filed under them.
 *
 * Adding the first stage clears the single approver, the panel, the final approver and escalation:
 * the server refuses those next to a chain, because they would never be asked.
 */
function ApprovalStagesControl({ value, step, onChange, onStepChange, definition, node, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const directory = useApprovalDirectory();
    const stages = canonicalStages(value);
    const used = stages.reduce((n, s) => n + s.approvers.length, 0);
    const commit = (next: ApprovalStage[]) => {
        const chain = canonicalStages(next);
        if (!stages.length && chain.length && onStepChange) {
            onStepChange({ ...(withoutSupersededApprovers(step) as AppAction), stages: chain });
            return;
        }
        onChange(chain.length ? chain : undefined);
    };
    const move = (i: number, d: number) => {
        const j = i + d;
        if (j < 0 || j >= stages.length) return;
        const next = stages.slice();
        [next[i], next[j]] = [next[j], next[i]];
        commit(next);
    };
    const addStage = (seat: Seat) => commit([...stages, { key: newStageKey(stages), approvers: [seat], rule: 'all' }]);
    return (
        <FormField
            label={t('studio_apps_step_fields.stages.label', 'Approval stages')}
            hint={t('studio_apps_step_fields.stages.hint', 'Up to {max} named stages, asked one after another. Used instead of a single approver or a panel.', { max: MAX_APPROVAL_STAGES })}
        >
            <div className="flex flex-col gap-2" data-step-control="approvalStages">
                {stages.map((stage, i) => (
                    <StageRow
                        key={stage.key || i}
                        stage={stage}
                        index={i}
                        total={stages.length}
                        budgetLeft={MAX_TOTAL_STAGE_SEATS - used}
                        directory={directory}
                        onPatch={(p) => commit(stages.map((s, j) => (j === i ? { ...s, ...p } : s)))}
                        onMove={(d) => move(i, d)}
                        onRemove={() => commit(stages.filter((_, j) => j !== i))}
                        definition={definition}
                        node={node}
                        disabled={disabled}
                        t={t}
                    />
                ))}
                {stages.length < MAX_APPROVAL_STAGES && used < MAX_TOTAL_STAGE_SEATS ? (
                    <SeatPicker
                        directory={directory}
                        onPick={addStage}
                        placeholder={stages.length ? t('studio_apps_step_fields.stages.add', '+ Add a stage: pick who decides it…') : t('studio_apps_step_fields.stages.add_first', '+ Use stages: pick who decides the first one…')}
                        ariaLabel={t('studio_apps_step_fields.stages.add_aria', 'Add a stage')}
                        disabled={disabled}
                    />
                ) : null}
                <span className="text-[11px] text-[var(--text-secondary)]">
                    {t('studio_apps_step_fields.stages.budget', '{used} of {max} approvers used across the chain', { used, max: MAX_TOTAL_STAGE_SEATS })}
                </span>
            </div>
        </FormField>
    );
}

interface SeatPickerProps {
    directory: ApprovalDirectory | null;
    onPick: (seat: Seat) => void;
    placeholder: string;
    ariaLabel: string;
    disabled: boolean;
}

/** A select that adds the seat it is set to and resets: nothing half-picked is ever stored. */
function SeatPicker({ directory, onPick, placeholder, ariaLabel, disabled }: SeatPickerProps) {
    return (
        <select
            className={INPUT_CLS}
            value=""
            onChange={(e) => { const seat = seatFromSelectValue(e.target.value); if (seat) onPick(seat); }}
            disabled={disabled}
            aria-label={ariaLabel}
        >
            <option value="">{placeholder}</option>
            <DirectoryOptions directory={directory} />
        </select>
    );
}

interface StageRowProps {
    stage: ApprovalStage;
    index: number;
    total: number;
    budgetLeft: number;
    directory: ApprovalDirectory | null;
    onPatch: (p: Partial<ApprovalStage>) => void;
    onMove: (delta: number) => void;
    onRemove: () => void;
    definition: StepFieldControlProps['definition'];
    node: StepFieldControlProps['node'];
    disabled: boolean;
    t: TranslateFn;
}

function StageRow({ stage, index, total, budgetLeft, directory, onPatch, onMove, onRemove, definition, node, disabled, t }: StageRowProps) {
    const n = index + 1;
    const iconCls = 'shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-30';
    return (
        <div className="flex flex-col gap-1.5 rounded-md border border-[var(--border-subtle)] p-2" data-stage-key={stage.key}>
            <div className="flex items-center gap-1.5">
                <StageText value={stage.name} max={MAX_STAGE_NAME_LEN} onChange={(name) => onPatch({ name })} placeholder={t('studio_apps_step_fields.stages.name_placeholder', 'Stage name, e.g. Finance')} ariaLabel={t('studio_apps_step_fields.stages.name_aria', 'Name of stage {n}', { n })} disabled={disabled} t={t} />
                <button type="button" onClick={() => onMove(-1)} disabled={disabled || index === 0} aria-label={t('studio_apps_step_fields.stages.up', 'Move stage {n} earlier', { n })} className={iconCls}><ChevronUp size={13} /></button>
                <button type="button" onClick={() => onMove(1)} disabled={disabled || index === total - 1} aria-label={t('studio_apps_step_fields.stages.down', 'Move stage {n} later', { n })} className={iconCls}><ChevronDown size={13} /></button>
                <button type="button" onClick={onRemove} disabled={disabled} aria-label={t('studio_apps_step_fields.stages.remove', 'Remove stage {n}', { n })} className={`${iconCls} hover:text-[var(--error)]`}><Trash2 size={13} /></button>
            </div>
            <StageText value={stage.description} max={MAX_STAGE_DESCRIPTION_LEN} onChange={(description) => onPatch({ description })} placeholder={t('studio_apps_step_fields.stages.description_placeholder', 'What do these approvers check? (optional)')} ariaLabel={t('studio_apps_step_fields.stages.description_aria', 'Description of stage {n}', { n })} disabled={disabled} t={t} />
            <StageSeats stage={stage} n={n} budgetLeft={budgetLeft} directory={directory} onPatch={onPatch} disabled={disabled} t={t} />
            <StageWhen value={stage.when} n={n} onChange={(when) => onPatch({ when })} definition={definition} node={node} disabled={disabled} t={t} />
        </div>
    );
}

interface StageTextProps {
    value: unknown;
    max: number;
    onChange: (next: string) => void;
    placeholder: string;
    ariaLabel: string;
    disabled: boolean;
    t: TranslateFn;
}

/** A stage name or description. One set by a formula (a binding) is shown, and left alone. */
function StageText({ value, max, onChange, placeholder, ariaLabel, disabled, t }: StageTextProps) {
    if (value && typeof value === 'object') {
        return <span className="flex-1 text-[11px] text-[var(--text-secondary)]">{t('studio_apps_step_fields.stages.computed', 'Worked out when the request is made.')}</span>;
    }
    const text = typeof value === 'string' ? value : '';
    return (
        <input
            type="text"
            className={INPUT_CLS}
            value={text}
            maxLength={max}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => { if (text.trim() !== text) onChange(text.trim()); }}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={ariaLabel}
        />
    );
}

interface StageSeatsProps {
    stage: ApprovalStage;
    n: number;
    budgetLeft: number;
    directory: ApprovalDirectory | null;
    onPatch: (p: Partial<ApprovalStage>) => void;
    disabled: boolean;
    t: TranslateFn;
}

/** The stage's approvers, its decision rule once two can decide, and the quorum count. */
function StageSeats({ stage, n, budgetLeft, directory, onPatch, disabled, t }: StageSeatsProps) {
    const seats = stage.approvers;
    const known = new Set([...(directory?.members || []).map((m) => `u:${m.id}`), ...(directory?.groups || []).map((g) => `g:${g.id}`)]);
    const setSeat = (si: number, encoded: string) => {
        const seat = seatFromSelectValue(encoded);
        if (seat) onPatch({ approvers: seats.map((s, j) => (j === si ? seat : s)) });
    };
    return (
        <div className="flex flex-col gap-1">
            {seats.map((seat, si) => {
                const encoded = seatSelectValue(seat);
                return (
                    <div key={encoded || si} className="flex items-center gap-1.5">
                        <select className={INPUT_CLS} value={encoded} onChange={(e) => setSeat(si, e.target.value)} disabled={disabled} aria-label={t('studio_apps_step_fields.stages.seat_aria', 'Stage {n}, approver {s}', { n, s: si + 1 })}>
                            {known.has(encoded) ? null : <option value={encoded}>{t('studio_apps_step_fields.directory.unknown', '{id} (not in the directory)', { id: seat.userId || seat.groupId || '' })}</option>}
                            <DirectoryOptions directory={directory} />
                        </select>
                        {seats.length > 1 ? (
                            <button type="button" onClick={() => onPatch({ approvers: seats.filter((_, j) => j !== si) })} disabled={disabled} aria-label={t('studio_apps_step_fields.stages.seat_remove', 'Remove approver {s} from stage {n}', { n, s: si + 1 })} className="shrink-0 p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]"><X size={12} /></button>
                        ) : null}
                    </div>
                );
            })}
            {seats.length < MAX_SEATS_PER_STAGE && budgetLeft > 0 ? (
                <SeatPicker directory={directory} onPick={(seat) => onPatch({ approvers: [...seats, seat] })} placeholder={t('studio_apps_step_fields.stages.seat_add', '+ Add an approver…')} ariaLabel={t('studio_apps_step_fields.stages.seat_add_aria', 'Add an approver to stage {n}', { n })} disabled={disabled} />
            ) : null}
            {seats.length >= 2 ? <StageRule stage={stage} n={n} onPatch={onPatch} disabled={disabled} t={t} /> : null}
        </div>
    );
}

function StageRule({ stage, n, onPatch, disabled, t }: { stage: ApprovalStage; n: number; onPatch: (p: Partial<ApprovalStage>) => void; disabled: boolean; t: TranslateFn }) {
    const count = stage.approvers.length;
    return (
        <div className="flex items-center gap-1.5">
            <select className={INPUT_CLS} value={stage.rule} onChange={(e) => onPatch({ rule: e.target.value })} disabled={disabled} aria-label={t('studio_apps_step_fields.stages.rule_aria', 'Decision rule for stage {n}', { n })}>
                <option value="all">{t('studio_apps_step_fields.stages.rule_all', 'Everyone must approve')}</option>
                <option value="first">{t('studio_apps_step_fields.stages.rule_first', 'First to respond decides')}</option>
                <option value="quorum">{t('studio_apps_step_fields.stages.rule_quorum', 'At least N approvals')}</option>
            </select>
            {stage.rule === 'quorum' ? (
                <select className={`${INPUT_CLS} max-w-[6rem]`} value={String(stage.quorum ?? Math.min(2, count))} onChange={(e) => onPatch({ quorum: Number(e.target.value) })} disabled={disabled} aria-label={t('studio_apps_step_fields.stages.quorum_aria', 'Approvals needed in stage {n}', { n })}>
                    {Array.from({ length: count }, (_, i) => i + 1).map((q) => <option key={q} value={String(q)}>{t('studio_apps_step_fields.stages.quorum_option', '{q} of {count}', { q, count })}</option>)}
                </select>
            ) : null}
        </div>
    );
}

interface StageWhenProps {
    value: string | undefined;
    n: number;
    onChange: (next: string) => void;
    definition: StepFieldControlProps['definition'];
    node: StepFieldControlProps['node'];
    disabled: boolean;
    t: TranslateFn;
}

/** The stage's condition, collapsed until asked for: most stages always run. Checked once, when the request is made. */
function StageWhen({ value, n, onChange, definition, node, disabled, t }: StageWhenProps) {
    const [asked, setAsked] = useState(false);
    if (!asked && !value) {
        return (
            <button type="button" onClick={() => setAsked(true)} disabled={disabled} className="self-start text-[11px] text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]">
                {t('studio_apps_step_fields.stages.when_add', '+ Only ask this stage when…')}
            </button>
        );
    }
    return (
        <div className="flex flex-col gap-1">
            <ExpressionInput
                variant="inline"
                value={value || ''}
                onChange={onChange}
                definition={definition}
                node={node}
                expectsBoolean
                placeholder={t('studio_apps_step_fields.stages.when_placeholder', 'e.g. number(form.amount_total) >= 5000')}
                ariaLabel={t('studio_apps_step_fields.stages.when_aria', 'Condition of stage {n}', { n })}
                disabled={disabled}
            />
            <button type="button" onClick={() => { setAsked(false); onChange(''); }} disabled={disabled} className="self-start text-[11px] text-[var(--text-secondary)] underline underline-offset-2 hover:text-[var(--text-primary)]">
                {t('studio_apps_step_fields.stages.when_clear', 'Always ask it')}
            </button>
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'approvalStages', Control: ApprovalStagesControl };
export default entry;
