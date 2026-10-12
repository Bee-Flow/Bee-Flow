import { AlertTriangle } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import Button from '../../../../../shared/Button';
import { confirmMatches, type RemoveMode } from './stageSettingsModel';

/**
 * Detach or remove the stage (design 5.4, 6.8), behind a typed confirmation.
 *
 *  - Detach is the escape hatch: the stage stops being a stage and becomes an
 *    ordinary Solution with everything in it. Nothing is deleted. It needs no
 *    licence.
 *  - Remove takes the stage down. Without `deleteData` its tables and knowledge
 *    bases stay with their data; with it they are deleted, and the dialog says
 *    so before the name is typed. In Production with the gate on, removal is a
 *    request the approvers decide (202), and the result says "requested", not
 *    "removed".
 */

export interface DangerZoneProps {
    /** The name to type: the Solution's. */
    solutionName: string;
    stageLabel: string;
    canAct: boolean;
    gateOn: boolean;
    busy: boolean;
    error: string | null;
    result: 'detached' | 'removal_started' | 'removal_requested' | null;
    onSubmit: (input: { mode: RemoveMode; confirm: string; deleteData: boolean }) => void;
}

const INPUT = 'w-full px-2 py-1.5 rounded-lg text-sm border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[var(--text-primary)]';

export default function DangerZone({ solutionName, stageLabel, canAct, gateOn, busy, error, result, onSubmit }: DangerZoneProps) {
    const { t } = useTranslation();
    const [mode, setMode] = useState<RemoveMode>('detach');
    const [deleteData, setDeleteData] = useState(false);
    const [typed, setTyped] = useState('');
    const ready = canAct && confirmMatches(typed, solutionName) && !busy;

    if (!canAct) {
        return <p className="text-sm text-[var(--text-tertiary)]" data-testid="danger-no-access">{t('stage_settings.danger_owner_only', 'Only the owner of this Solution or an organisation admin can detach or remove a stage.')}</p>;
    }
    if (result) {
        return (
            <p className="px-3 py-2 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-primary)]" role="status" data-testid="danger-result" data-result={result}>
                {result === 'detached' && t('stage_settings.danger_detached', '{stage} is now an ordinary Solution. Nothing was deleted.', { stage: stageLabel })}
                {result === 'removal_started' && t('stage_settings.danger_removing', '{stage} is being removed. This takes a moment.', { stage: stageLabel })}
                {result === 'removal_requested' && t('stage_settings.danger_requested', 'Removal of {stage} was requested. Nothing is removed until the approvers agree.', { stage: stageLabel })}
            </p>
        );
    }
    return (
        <div className="space-y-3" data-testid="settings-danger">
            <fieldset className="space-y-2">
                <legend className="sr-only">{t('stage_settings.danger_mode', 'What to do with this stage')}</legend>
                <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="radio" name="remove-mode" checked={mode === 'detach'} onChange={() => setMode('detach')} data-testid="danger-mode-detach" className="mt-0.5" />
                    <span>{t('stage_settings.danger_detach', 'Detach')}
                        <span className="block text-xs text-[var(--text-tertiary)]">{t('stage_settings.danger_detach_hint', 'The stage becomes an ordinary Solution with everything in it. Nothing is deleted, and it no longer receives deployments.')}</span>
                    </span>
                </label>
                <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="radio" name="remove-mode" checked={mode === 'delete'} onChange={() => setMode('delete')} data-testid="danger-mode-delete" className="mt-0.5" />
                    <span>{t('stage_settings.danger_remove', 'Remove')}
                        <span className="block text-xs text-[var(--text-tertiary)]">{t('stage_settings.danger_remove_hint', 'Everything deployed in this stage is taken down.')}</span>
                    </span>
                </label>
            </fieldset>
            {mode === 'delete' && (
                <label className="flex items-start gap-2 text-sm text-[var(--text-primary)]">
                    <input type="checkbox" checked={deleteData} onChange={(e) => setDeleteData(e.target.checked)} data-testid="danger-delete-data" className="mt-0.5" />
                    <span>{t('stage_settings.danger_delete_data', 'Also delete the tables and knowledge bases of this stage, with their data')}
                        <span className="block text-xs text-[var(--text-tertiary)]">
                            {deleteData
                                ? t('stage_settings.danger_delete_data_yes', 'The data cannot be recovered.')
                                : t('stage_settings.danger_delete_data_no', 'Left unchecked, the tables and their data stay, owned by the run-as person.')}
                        </span>
                    </span>
                </label>
            )}
            {mode === 'delete' && deleteData && (
                <p className="flex items-start gap-2 text-sm text-[var(--error)]" data-testid="danger-data-warning">
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                    {t('stage_settings.danger_data_warning', 'This deletes the data of {stage}. It cannot be undone.', { stage: stageLabel })}
                </p>
            )}
            {mode === 'delete' && gateOn && (
                <p className="text-xs text-[var(--text-secondary)]" data-testid="danger-needs-approval">{t('stage_settings.danger_needs_approval', 'Production approval is on: removing it is sent to the approvers first.')}</p>
            )}
            <label className="block text-xs text-[var(--text-tertiary)]">
                {t('stage_settings.danger_type', 'Type the name of the Solution to confirm: {name}', { name: solutionName })}
                <input className={`${INPUT} mt-1`} value={typed} onChange={(e) => setTyped(e.target.value)} data-testid="danger-confirm" autoComplete="off" />
            </label>
            {error && <p className="text-sm text-[var(--error)]" role="alert" data-testid="danger-error">{error}</p>}
            <Button
                size="sm" variant="danger" disabled={!ready} busy={busy} data-testid="danger-submit"
                onClick={() => onSubmit({ mode, confirm: typed, deleteData: mode === 'delete' && deleteData })}
            >
                {mode === 'detach'
                    ? t('stage_settings.danger_go_detach', 'Detach {stage}', { stage: stageLabel })
                    : t('stage_settings.danger_go_remove', 'Remove {stage}', { stage: stageLabel })}
            </Button>
        </div>
    );
}
