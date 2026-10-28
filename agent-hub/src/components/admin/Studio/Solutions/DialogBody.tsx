import { AlertTriangle, HelpCircle, Loader2 } from 'lucide-react';
import { Strip } from './solutionNotices';
import { useTranslation } from '@/hooks/useTranslation';
import { nOf } from '../KnowledgeStudio/plural';
import type { PlanRows, ReadReport, PlanGroupProps, DialogBodyProps } from './upgradeClient.types';

function PlanGroup({ rows, title, note, testId }: PlanGroupProps) {
    if (!rows || rows.length === 0) return null;
    return (
        <div data-testid={testId}>
            <h3 className="text-sm font-medium text-[var(--text-primary)]">{title}</h3>
            {note && <p className="text-xs mt-0.5 text-[var(--text-tertiary)]">{note}</p>}
            <ul className="mt-1.5 space-y-1">
                {rows.map((row, i) => (
                    <li key={`${row.ref}-${i}`} className="px-3 py-1.5 rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-sm text-[var(--text-secondary)] break-words">
                        {row.name}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** Alle vijf de groepen, in de volgorde waarin iemand ze wil lezen. */
export function PlanBody({ rows }: { rows: PlanRows }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            <PlanGroup
                rows={rows.changed} testId="upgrade-group-changed"
                title={nOf(t, 'solutions.upgrade_changed', rows.changed.length,
                    '{count} thing is replaced by the new version', '{count} things are replaced by the new version')}
                note={t('solutions.upgrade_changed_note', 'You have not touched these since you installed them.')}
            />
            <PlanGroup
                rows={rows.added} testId="upgrade-group-added"
                title={nOf(t, 'solutions.upgrade_added', rows.added.length,
                    '{count} thing is added', '{count} things are added')}
            />
            <PlanGroup
                rows={rows.kept} testId="upgrade-group-kept"
                title={nOf(t, 'solutions.upgrade_kept', rows.kept.length,
                    '{count} thing you changed stays as it is', '{count} things you changed stay as they are')}
                note={t('solutions.upgrade_kept_note', 'Your version is kept — the update does not write over it.')}
            />
            {/* The group this screen exists for: it is NOT determinable here whether the
                installer changed something himself, and that is stated here. */}
            <PlanGroup
                rows={rows.undetermined} testId="upgrade-group-undetermined"
                title={nOf(t, 'solutions.upgrade_undetermined', rows.undetermined.length,
                    '{count} thing stays as it is', '{count} things stay as they are')}
                note={t('solutions.upgrade_undetermined_note',
                    'These are left as they are without checking whether you changed them — a table or knowledge base is never rewritten because it holds live data, and anything the update could not read is left alone rather than guessed at. This is not a statement that you did not change them.')}
            />
            <PlanGroup
                rows={rows.gone} testId="upgrade-group-gone"
                title={nOf(t, 'solutions.upgrade_gone', rows.gone.length,
                    '{count} thing you deleted is not brought back', '{count} things you deleted are not brought back')}
                note={t('solutions.upgrade_gone_note', 'These were installed once and are gone now. Deleting them was a decision, so the update leaves them out.')}
            />
        </div>
    );
}

/** Wat er daarna gebeurd is. Tellingen, plus de zinnen die de server meegaf. */
function ReportBody({ report }: { report: ReadReport }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-3" data-testid="upgrade-report">
            <p className="text-sm text-[var(--text-primary)]">
                {t('solutions.upgrade_done', 'Updated. {replaced} replaced, {added} added.',
                    { replaced: report.replaced, added: report.added })}
            </p>
            {report.failed.length > 0 && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-report-failed">
                    {t('solutions.upgrade_failed_some', 'Some of it did not go through:')}
                    <span className="block text-xs mt-1 text-[var(--text-tertiary)]">
                        {report.failed.map(f => f.why).filter(Boolean).join(' · ')}
                    </span>
                </Strip>
            )}
            {report.warnings.map((w, i) => (
                <p key={i} className="text-xs text-[var(--text-tertiary)]">{w}</p>
            ))}
        </div>
    );
}

export function DialogBody({ plan, ready, empty, result }: DialogBodyProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-4">
            {plan.status === 'loading' && (
                <div className="flex items-center justify-center py-10 text-[var(--text-tertiary)]">
                    <Loader2 className="w-5 h-5 animate-spin" />
                </div>
            )}

            {/* Geen plan = geen knop. Er is niets bekend om te bevestigen. */}
            {plan.status === 'error' && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-plan-unreadable">
                    {t('solutions.upgrade_plan_unreadable',
                        'What this update would change could not be worked out, so nothing has been applied.')}
                </Strip>
            )}

            {ready && empty && (
                <Strip tone="var(--text-tertiary)" icon={HelpCircle} testId="upgrade-plan-empty">
                    {t('solutions.upgrade_nothing', 'This update would not change or add anything here.')}
                </Strip>
            )}

            {ready && plan.rows && <PlanBody rows={plan.rows} />}

            {result?.status === 'error' && (
                <Strip tone="var(--error)" icon={AlertTriangle} testId="upgrade-apply-failed">
                    {t('solutions.upgrade_apply_failed', 'The update did not go through. Nothing that was already replaced is undone — try again, and read the plan first.')}
                </Strip>
            )}
            {result?.status === 'ok' && <ReportBody report={result.report} />}
        </div>
    );
}
