import React, { useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { ScenarioItem } from '@/api/queries/automation/runChecks';
import {
    useDeleteFormScenario, useDryRunFormScenario, useFormScenarios, useRenameFormScenario,
} from '@/api/queries/automation/runChecks';
import HelpPopover from './HelpPopover';
import { scenarioErrorText } from './runChecksErrors';
import { PRIMARY_BTN, SECONDARY_BTN, TEXT_INPUT } from './runChecksStyles';

interface ScenarioRowProps {
    scenario: ScenarioItem;
    busy: boolean;
    onDryRun: (s: ScenarioItem) => void;
    onRename: (s: ScenarioItem, name: string) => Promise<boolean>;
    onDelete: (s: ScenarioItem) => Promise<void>;
}

function ScenarioRow({ scenario, busy, onDryRun, onRename, onDelete }: ScenarioRowProps) {
    const { t, locale } = useTranslation();
    const [mode, setMode] = useState<'view' | 'rename' | 'delete'>('view');
    const [name, setName] = useState(scenario.name);
    const answered = scenario.pages.length + (scenario.hasTriggerAnswers ? 1 : 0);
    const captured = scenario.createdAt
        ? new Date(scenario.createdAt).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
        : '';
    const pagesText = answered === 1
        ? t('automation_run_checks.scenario.pages_one', '1 page answered')
        : t('automation_run_checks.scenario.pages_other', '{n} pages answered', { n: answered });

    const saveName = async () => {
        if (await onRename(scenario, name.trim())) setMode('view');
    };

    return (
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
            {mode === 'rename' ? (
                <div className="flex gap-1.5">
                    <input
                        value={name}
                        onChange={e => setName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') void saveName(); }}
                        maxLength={80}
                        aria-label={t('automation_run_checks.scenario.name_field', 'Scenario name')}
                        className={`min-w-0 flex-1 ${TEXT_INPUT}`}
                    />
                    <button type="button" className={PRIMARY_BTN} onClick={saveName} disabled={!name.trim() || busy}>
                        {t('automation_run_checks.scenario.save_name', 'Save name')}
                    </button>
                    <button type="button" className={SECONDARY_BTN} onClick={() => { setMode('view'); setName(scenario.name); }}>
                        {t('automation_run_checks.scenario.cancel', 'Cancel')}
                    </button>
                </div>
            ) : (
                <div className="font-medium text-[var(--text-primary)] truncate">{scenario.name}</div>
            )}
            <div className="mt-0.5 flex flex-wrap gap-x-3 text-[var(--text-tertiary)]">
                <span>{pagesText}</span>
                {captured && <span>{t('automation_run_checks.scenario.captured', 'Saved {date}', { date: captured })}</span>}
                {scenario.skipped.length > 0 && (
                    <span>
                        {scenario.skipped.length === 1
                            ? t('automation_run_checks.scenario.skipped_one', '1 field not saved (files and app picks)')
                            : t('automation_run_checks.scenario.skipped_other', '{n} fields not saved (files and app picks)', { n: scenario.skipped.length })}
                    </span>
                )}
            </div>
            {mode === 'delete' ? (
                <div className="mt-1.5 flex items-center gap-2">
                    <span className="text-[var(--text-secondary)]">{t('automation_run_checks.scenario.delete_ask', 'Delete this scenario?')}</span>
                    <button type="button" className={SECONDARY_BTN} onClick={() => void onDelete(scenario)} disabled={busy}>
                        {t('automation_run_checks.scenario.delete_yes', 'Yes, delete')}
                    </button>
                    <button type="button" className={SECONDARY_BTN} onClick={() => setMode('view')}>
                        {t('automation_run_checks.scenario.cancel', 'Cancel')}
                    </button>
                </div>
            ) : (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[var(--accent-primary)]">
                    <button type="button" className="font-medium hover:underline disabled:opacity-50" onClick={() => onDryRun(scenario)} disabled={busy}>
                        {t('automation_run_checks.scenario.dry_run', 'Dry run')}
                    </button>
                    <button type="button" className="hover:underline" onClick={() => setMode('rename')}>
                        {t('automation_run_checks.scenario.rename', 'Rename')}
                    </button>
                    <button type="button" className="text-[var(--text-secondary)] hover:underline" onClick={() => setMode('delete')}>
                        {t('automation_run_checks.scenario.delete', 'Delete')}
                    </button>
                </div>
            )}
        </li>
    );
}

interface FormScenariosPanelProps {
    automationId: string;
    active?: boolean;
    /** Select a run in the Runs tab, so its steps show. */
    onOpenRun: (runId: string) => void;
}

/** The Testing tab's form scenarios: saved answers, tried again as a dry run. */
export default function FormScenariosPanel({ automationId, active = true, onOpenRun }: FormScenariosPanelProps) {
    const { t } = useTranslation();
    const scenarios = useFormScenarios(automationId, active);
    const dryRun = useDryRunFormScenario(automationId);
    const rename = useRenameFormScenario(automationId);
    const remove = useDeleteFormScenario(automationId);
    const [error, setError] = useState<string | null>(null);

    const list = scenarios.data?.scenarios ?? [];
    const max = scenarios.data?.max ?? null;
    const busy = dryRun.isPending || rename.isPending || remove.isPending;

    const run = async (s: ScenarioItem) => {
        setError(null);
        try {
            const out = await dryRun.mutateAsync({ scenarioId: s.scenarioId });
            if (out.runId) onOpenRun(out.runId);
        } catch (e) {
            setError(scenarioErrorText(e, t));
        }
    };
    const doRename = async (s: ScenarioItem, name: string): Promise<boolean> => {
        setError(null);
        try {
            await rename.mutateAsync({ scenarioId: s.scenarioId, name });
            return true;
        } catch (e) {
            setError(scenarioErrorText(e, t));
            return false;
        }
    };
    const doDelete = async (s: ScenarioItem) => {
        setError(null);
        try {
            await remove.mutateAsync(s.scenarioId);
        } catch (e) {
            setError(scenarioErrorText(e, t));
        }
    };

    return (
        <section aria-label={t('automation_run_checks.scenario.section', 'Form scenarios')} className="flex flex-col gap-2.5 p-4 text-xs">
            <div className="flex items-center gap-1.5">
                <h3 className="font-semibold text-sm text-[var(--text-primary)]">{t('automation_run_checks.scenario.section', 'Form scenarios')}</h3>
                <HelpPopover label={t('automation_run_checks.scenario.help_label', 'What is a form scenario?')}>
                    {t('automation_run_checks.scenario.help', 'A scenario is a saved set of answers for each page of a form, taken from a run. A dry run with a scenario fills every page automatically and sends nothing. Scenarios are run data: they follow run retention and are never exported or deployed.')}
                </HelpPopover>
                {max != null && (
                    <span className="ml-auto text-[var(--text-tertiary)]">
                        {t('automation_run_checks.golden.count_of_max', '{n} of {max}', { n: list.length, max })}
                    </span>
                )}
            </div>
            {scenarios.isError && <p role="alert" className="text-[var(--error)]">{t('automation_run_checks.scenario.load_failed', 'Could not load the scenarios.')}</p>}
            {scenarios.isSuccess && list.length === 0 && (
                <p className="text-[var(--text-tertiary)]">
                    {t('automation_run_checks.scenario.empty', 'No scenarios yet. Test a form, and when the run is done choose "Save these answers as a scenario".')}
                </p>
            )}
            {dryRun.isPending && <p className="text-[var(--text-secondary)]">{t('automation_run_checks.scenario.running', 'Running the dry run…')}</p>}
            {error && <p role="alert" className="text-[var(--error)]">{error}</p>}
            {list.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                    {list.map(s => (
                        <ScenarioRow key={s.scenarioId} scenario={s} busy={busy} onDryRun={run} onRename={doRename} onDelete={doDelete} />
                    ))}
                </ul>
            )}
        </section>
    );
}
