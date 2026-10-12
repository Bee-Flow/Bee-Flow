import { AlertTriangle, Lock } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import { ApprovalStagesEditor } from '../../../../../automation/Builder/flow/settings/approvalStages';
import { newStageKey, sanitizeApprovalStages } from '../../../../../automation/Builder/flow/settings/formState';
import Button from '../../../../../shared/Button';
import type { Directory, GatePatch } from './stageSettingsApi';
import { policyProblems, type ApprovalStage, type GateOutcome, type SettingsError, type StageSettings } from './stageSettingsModel';

/**
 * The Production approval gate (design 6.6, D19): the toggle, the chain of
 * approvers it asks, and whether a rollback needs approval too.
 *
 * Turning the gate ON is a plain write. Once it is on, switching it off or
 * changing its chain is itself a deployment that the CURRENT chain approves, so
 * the server answers 202 and this section shows "approval requested" instead of
 * pretending the change happened. A chain in which a stage has nobody but the
 * Solution owner is flagged here before the server refuses it
 * (approval_policy_needs_approver): with four-eyes the owner can never decide
 * their own request.
 */

interface ChainEditorProps {
    stages: ApprovalStage[];
    onChange: (next: ApprovalStage[]) => void;
    onDrop: () => void;
    directory: Directory | null;
}

type EditorProps = {
    stages: ApprovalStage[]; set: (key: string, next: ApprovalStage[]) => void; directory: Directory | null;
    onFocusField?: () => void; previewSample?: unknown; onDropStages: () => void; t: unknown;
};
const StagesEditor = ApprovalStagesEditor as unknown as React.ComponentType<EditorProps>;

/** The automation builder's approval chain editor, shared with the seat bindings. */
export function ChainEditor({ stages, onChange, onDrop, directory }: ChainEditorProps) {
    const { t } = useTranslation();
    return <StagesEditor stages={stages} set={(_key, next) => onChange(next)} directory={directory} onDropStages={onDrop} t={t} />;
}

export const newChain = (): ApprovalStage[] => [{ key: newStageKey([]), name: '', description: '', approvers: [null], rule: 'all' }];

export interface GateSectionProps {
    settings: StageSettings;
    isOwner: boolean;
    /** The approvals licence; without it the toggle is locked. */
    licensed: boolean;
    directory: Directory | null;
    busy: boolean;
    outcome: GateOutcome | null;
    error: SettingsError | null;
    onSave: (patch: GatePatch) => void;
}

export default function GateSection({ settings, isOwner, licensed, directory, busy, outcome, error, onSave }: GateSectionProps) {
    const { t } = useTranslation();
    const [on, setOn] = useState(settings.requiresApproval);
    const [rollback, setRollback] = useState(settings.rollbackNeedsApproval);
    const [stages, setStages] = useState<ApprovalStage[]>(() => (settings.approvalPolicy?.stages?.length ? settings.approvalPolicy.stages : newChain()));

    const sanitized = useMemo(() => sanitizeApprovalStages(stages) as ApprovalStage[], [stages]);
    const problems = useMemo(() => (on ? policyProblems({ stages: sanitized }, settings.runAs.userId) : []), [on, sanitized, settings.runAs.userId]);
    const policyChanged = JSON.stringify(sanitized) !== JSON.stringify(settings.approvalPolicy?.stages || []);
    const dirty = on !== settings.requiresApproval || rollback !== settings.rollbackNeedsApproval || (on && policyChanged);
    const locked = !isOwner || (!licensed && !settings.requiresApproval);
    const alreadyOn = settings.requiresApproval;

    const save = () => {
        const patch: GatePatch = {};
        if (on !== settings.requiresApproval) patch.requiresApproval = on;
        if (rollback !== settings.rollbackNeedsApproval) patch.rollbackNeedsApproval = rollback;
        if (on && policyChanged) patch.approvalPolicy = { stages: sanitized };
        if (on && patch.requiresApproval && !patch.approvalPolicy) patch.approvalPolicy = { stages: sanitized };
        onSave(patch);
    };

    const problemText = (p: { stageKey: string; why: 'empty' | 'owner_only' }) => {
        const label = p.stageKey || t('stage_settings.gate_chain', 'The chain');
        return p.why === 'empty'
            ? t('stage_settings.gate_problem_empty', '{stage} has nobody in it. Pick at least one approver.', { stage: label })
            : t('stage_settings.gate_problem_owner', '{stage} only has the Solution owner. With four-eyes, someone else has to decide.', { stage: label });
    };

    return (
        <div className="space-y-3" data-testid="settings-gate">
            {!licensed && !alreadyOn && (
                <p className="flex items-start gap-2 text-sm text-[var(--text-secondary)]" data-testid="gate-unlicensed">
                    <Lock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    {t('stage_settings.gate_unlicensed', 'Your plan does not include approvals, so the gate cannot be switched on.')}
                </p>
            )}
            <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                <input
                    type="checkbox" checked={on} disabled={locked || busy}
                    onChange={(e) => setOn(e.target.checked)}
                    className="mt-0.5" data-testid="gate-toggle"
                />
                <span>
                    {t('stage_settings.gate_toggle', 'Production changes need approval')}
                    <span className="block text-xs text-[var(--text-tertiary)]">
                        {t('stage_settings.gate_toggle_hint', 'Every deployment, redeploy and removal waits for the approvers below.')}
                    </span>
                </span>
            </label>

            {on && (
                <>
                    <ChainEditor
                        stages={stages} onChange={setStages} directory={directory}
                        onDrop={() => setStages(newChain())}
                    />
                    <label className="flex items-center gap-2 text-sm text-[var(--text-primary)]">
                        <input type="checkbox" checked={rollback} disabled={locked || busy} onChange={(e) => setRollback(e.target.checked)} data-testid="gate-rollback" />
                        {t('stage_settings.gate_rollback', 'A rollback needs approval too')}
                    </label>
                    {problems.length > 0 && (
                        <ul className="space-y-1" data-testid="gate-problems">
                            {problems.map(p => (
                                <li key={`${p.stageKey}:${p.why}`} className="flex items-start gap-2 text-sm text-[var(--error)]">
                                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />{problemText(p)}
                                </li>
                            ))}
                        </ul>
                    )}
                </>
            )}

            {alreadyOn && dirty && (
                <p className="text-xs text-[var(--text-secondary)]" data-testid="gate-asks-first">
                    {t('stage_settings.gate_change_asks', 'The gate is on, so this change is itself sent to the current approvers. Nothing changes until they agree.')}
                </p>
            )}
            {error?.kind === 'policy_needs_approver' && (
                <p className="text-sm text-[var(--error)]" data-testid="gate-server-refused">
                    {t('stage_settings.gate_refused', 'The server refused this chain: every stage needs an approver who is not the Solution owner.')}
                </p>
            )}
            {error?.kind === 'licence' && (
                <p className="text-sm text-[var(--error)]">{t('stage_settings.gate_unlicensed', 'Your plan does not include approvals, so the gate cannot be switched on.')}</p>
            )}
            {outcome === 'approval_requested' && (
                <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]" data-testid="gate-approval-requested" role="status">
                    {t('stage_settings.gate_requested', 'Requested. The change to the gate applies once the approvers agree; until then it is unchanged.')}
                </p>
            )}
            {isOwner && (
                <Button
                    size="sm" disabled={!dirty || busy || locked || (on && problems.length > 0)} busy={busy} onClick={save}
                    data-testid="gate-save"
                >
                    {alreadyOn && dirty
                        ? t('stage_settings.gate_request', 'Ask for approval')
                        : t('stage_settings.gate_save', 'Save gate')}
                </Button>
            )}
        </div>
    );
}
