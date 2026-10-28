import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useCreateFormScenario } from '@/api/queries/automation/runChecks';
import { scenarioErrorText } from './runs/runChecksErrors';

/**
 * After a test run of a form: keep its answers as a named scenario, so the same
 * path can be tried again without typing it. The name is the only question.
 */
export default function FormSaveScenario({ automationId, runId }: { automationId: string | null | undefined; runId: string }) {
    const { t } = useTranslation();
    const create = useCreateFormScenario(automationId);
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [error, setError] = useState<string | null>(null);
    const [savedAs, setSavedAs] = useState<string | null>(null);

    const save = async () => {
        setError(null);
        try {
            const out = await create.mutateAsync({ name: name.trim(), fromRunId: runId });
            setSavedAs(out?.name || name.trim());
        } catch (e) {
            setError(scenarioErrorText(e, t));
        }
    };

    if (savedAs) {
        return <p role="status" className="mt-4 text-xs text-[var(--text-secondary)]">{t('automation_run_checks.save.saved', 'Saved as scenario "{name}".', { name: savedAs })}</p>;
    }
    if (!open) {
        return (
            <button type="button" onClick={() => setOpen(true)} className="mt-3 text-xs text-[var(--accent-primary)] hover:underline">
                {t('automation_run_checks.save.open', 'Save these answers as a scenario')}
            </button>
        );
    }
    return (
        <div className="mt-4 flex flex-col gap-1.5 text-left text-xs">
            <label htmlFor="scenario-name" className="font-medium text-[var(--text-secondary)]">
                {t('automation_run_checks.save.name', 'Scenario name')}
            </label>
            <div className="flex gap-1.5">
                <input
                    id="scenario-name"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && name.trim()) void save(); }}
                    maxLength={80}
                    placeholder={t('automation_run_checks.save.placeholder', 'For example: a complete request')}
                    className="min-w-0 flex-1 h-[30px] px-2 rounded-md border border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                />
                <button
                    type="button"
                    onClick={save}
                    disabled={!name.trim() || create.isPending}
                    className="h-[30px] px-3 rounded-lg bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] font-medium hover:opacity-90 disabled:opacity-50"
                >
                    {t('automation_run_checks.save.button', 'Save scenario')}
                </button>
            </div>
            <p className="text-[var(--text-tertiary)]">
                {t('automation_run_checks.save.help', 'Files and app picks are not saved. Scenarios are run data and are never exported or deployed.')}
            </p>
            {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
        </div>
    );
}
