import { CheckCircle2, XCircle } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import type { ComparisonScenario, ImportComparison } from '@/api/windmillImport';

type Translate = ReturnType<typeof useTranslation>['t'];

/** Why a flow was not compared, in one sentence. */
function statusText(status: Exclude<ImportComparison['status'], 'done'>, t: Translate): string {
    switch (status) {
        case 'no_runs': return t('automation_import.comparison_no_runs', 'Windmill has no finished runs of this flow, so there was nothing to compare.');
        case 'skipped_flow_limit': return t('automation_import.comparison_flow_limit', 'Not compared: this import already compared as many flows as this server allows.');
        case 'unauthorized': return t('automation_import.comparison_unauthorized', 'Not compared: the token may not read the runs of this workspace.');
        case 'budget_spent': return t('automation_import.comparison_budget_spent', 'Not compared: this import already read as much from Windmill as this server allows.');
        default: return t('automation_import.comparison_unreadable', 'Not compared: the runs could not be read from Windmill.');
    }
}

function Scenario({ s }: { s: ComparisonScenario }) {
    const { t } = useTranslation();
    return (
        <li className="space-y-1 rounded-md border border-[var(--border-default)] px-2 py-1">
            <div className="flex flex-wrap items-center gap-1.5">
                {s.reachedEnd
                    ? <CheckCircle2 size={13} className="text-[var(--success-ink)]" />
                    : <XCircle size={13} className="text-[var(--error-ink)]" />}
                <span className="font-medium">{s.reachedEnd
                    ? t('automation_import.comparison_reached_end', 'Reached the end')
                    : t('automation_import.comparison_not_reached', 'Did not reach the end')}</span>
                <span className="text-[var(--text-tertiary)] break-all">{t('automation_import.comparison_run', 'Windmill run {id}', { id: s.windmillRunId })}</span>
                {s.windmillSuccess === false && (
                    <span className="text-[var(--text-tertiary)]">{t('automation_import.comparison_windmill_failed', '(this run failed in Windmill too)')}</span>
                )}
            </div>
            {s.failedSteps.length > 0 && (
                <ul className="text-[11px] text-[var(--error-ink)]">
                    {s.failedSteps.map((f) => (
                        <li key={`${f.stepId}-${f.code}`} className="break-words">{t('automation_import.comparison_failed_step', 'Step {step} failed: {code}', { step: f.stepId, code: f.code })}</li>
                    ))}
                </ul>
            )}
            {s.shapeDiffs.length > 0 && (
                <ul className="space-y-0.5 text-[11px] text-[var(--text-secondary)]">
                    {s.shapeDiffs.map((d) => (
                        <li key={d.stepId} className="break-words">
                            <span className="text-[var(--warning-ink)]">{t('automation_import.comparison_shape', 'Step {step} gives a result with a different shape', { step: d.stepId })}</span>
                            {d.simulated && <span className="text-[var(--text-tertiary)]"> {t('automation_import.comparison_simulated', '(simulated in a dry run)')}</span>}
                            {d.missing.length > 0 && <div>{t('automation_import.comparison_missing', 'Missing in Bee Flow: {paths}', { paths: d.missing.join(', ') })}</div>}
                            {d.extra.length > 0 && <div>{t('automation_import.comparison_extra', 'Only in Bee Flow: {paths}', { paths: d.extra.join(', ') })}</div>}
                        </li>
                    ))}
                </ul>
            )}
            {s.saved && (
                <p className="text-[11px] text-[var(--text-tertiary)]">{s.saved.golden
                    ? t('automation_import.comparison_saved', 'Kept as a golden run')
                    : t('automation_import.comparison_not_saved', 'Not kept: only a dry run that reached the end can be a golden run.')}</p>
            )}
        </li>
    );
}

/**
 * The side-by-side comparison of one imported draft: per Windmill run, whether
 * the dry run of the draft reached the end, which steps failed and which give
 * a result with a different shape. Key paths and codes only: the runs' values
 * were never kept.
 */
export default function ComparisonSection({ comparison }: { comparison: ImportComparison }) {
    const { t } = useTranslation();
    const reached = comparison.scenarios.filter((s) => s.reachedEnd).length;
    return (
        <section aria-label={t('automation_import.comparison_title', 'Comparison with the last Windmill runs')} className="space-y-1.5">
            <h4 className="text-[12px] font-semibold text-[var(--text-primary)]">{t('automation_import.comparison_title', 'Comparison with the last Windmill runs')}</h4>
            {comparison.status === 'done' ? (
                <>
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        {t('automation_import.comparison_summary', '{reached} of {count} dry runs reached the end', { reached, count: comparison.scenarios.length })}
                    </p>
                    <ul className="space-y-1">
                        {comparison.scenarios.map((s) => <Scenario key={s.windmillRunId} s={s} />)}
                    </ul>
                    <p className="text-[11px] text-[var(--text-tertiary)]">
                        {t('automation_import.comparison_privacy', 'Only this summary is kept; the input and results of the Windmill runs are not stored.')}
                    </p>
                </>
            ) : (
                <p className="text-[11px] text-[var(--text-secondary)]">{statusText(comparison.status, t)}</p>
            )}
        </section>
    );
}
