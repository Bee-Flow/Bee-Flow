import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import type { ScenarioDetail, ScenarioItem } from '../../../api/queries/automation/runChecks';
import { useFormScenario, useFormScenarios } from '../../../api/queries/automation/runChecks';

/** The saved answers for one page: the start form's, or those of the paused page `stepId`. */
export function answersForPage(detail: ScenarioDetail, stepId: string | null): Record<string, unknown> {
    return (stepId ? detail.answers.pages[stepId] : detail.answers.trigger) ?? {};
}

/** Does this scenario hold answers for the page? */
export function coversPage(s: ScenarioItem, stepId: string | null): boolean {
    return stepId ? s.pages.some(p => p.stepId === stepId) : s.hasTriggerAnswers;
}

interface FormScenarioPickerProps {
    automationId: string | null | undefined;
    /** The form_page step the page belongs to; null for the first page (the start form). */
    stepId: string | null;
    /** The page's saved answers to fill in, or null to leave the form as it is. */
    onPick: (answers: Record<string, unknown> | null) => void;
}

/**
 * "Fill from a saved scenario" above a test form. Only scenarios that answered
 * THIS page are offered; the answers are read when one is picked, not before.
 */
export default function FormScenarioPicker({ automationId, stepId, onPick }: FormScenarioPickerProps) {
    const { t } = useTranslation();
    const list = useFormScenarios(automationId);
    const [selectedId, setSelectedId] = useState('');
    const [token, setToken] = useState(0);
    const applied = useRef(0);
    const detail = useFormScenario(automationId, selectedId || null);

    const options = (list.data?.scenarios ?? []).filter(s => coversPage(s, stepId));
    const selected = options.find(s => s.scenarioId === selectedId) ?? null;
    const skipped = selected ? selected.skipped.filter(s => (s.stepId ?? null) === stepId).map(s => s.field) : [];

    // A pick applies once; a background refresh of the same scenario must not overwrite what was typed since.
    useEffect(() => {
        const d = detail.data;
        if (!d || d.scenarioId !== selectedId || applied.current === token) return;
        applied.current = token;
        onPick(answersForPage(d, stepId));
    }, [detail.data, selectedId, token, stepId, onPick]);

    if (!options.length) return null;

    const change = (id: string) => {
        setSelectedId(id);
        setToken(n => n + 1);
        if (!id) onPick(null);
    };

    return (
        <div className="mb-3 flex flex-col gap-1 text-xs">
            <label htmlFor="form-scenario-picker" className="font-medium text-[var(--text-secondary)]">
                {t('automation_run_checks.picker.label', 'Fill from a saved scenario')}
            </label>
            <select
                id="form-scenario-picker"
                value={selectedId}
                onChange={e => change(e.target.value)}
                className="h-[30px] px-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
            >
                <option value="">{t('automation_run_checks.picker.none', 'Start with an empty form')}</option>
                {options.map(s => <option key={s.scenarioId} value={s.scenarioId}>{s.name}</option>)}
            </select>
            {detail.isError && selectedId && (
                <p role="alert" className="text-[var(--error)]">{t('automation_run_checks.picker.load_failed', 'Could not load that scenario.')}</p>
            )}
            {skipped.length > 0 && (
                <p className="text-[var(--text-tertiary)]">
                    {t('automation_run_checks.picker.skipped', 'Left empty: {fields}. Files and app picks are not saved.', { fields: skipped.join(', ') })}
                </p>
            )}
        </div>
    );
}
