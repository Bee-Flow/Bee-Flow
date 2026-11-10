import { Loader2, Stethoscope } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { isDiagnosticsRateLimited, useRunMyTeamsDiagnostics } from '@/api/queries/teamsSetup';
import DiagnosticsChecklist from './DiagnosticsChecklist';

/**
 * "Test my connection": runs the Teams checklist for the signed-in person's own Microsoft
 * connection (POST /api/teams-setup/me/diagnostics) and shows the result. Read-only on
 * Microsoft's side; the server limits how often it may run, which reads as a short wait.
 */
export default function TeamsConnectionTest() {
    const { t } = useTranslation();
    const run = useRunMyTeamsDiagnostics();
    const report = run.data;
    const busy = run.isPending;
    let error: string | null = null;
    if (run.isError) error = isDiagnosticsRateLimited(run.error) ? t('teams_setup.ui.rate_limited') : t('teams_setup.ui.test_failed');

    return (
        <div className="flex flex-col gap-3" data-testid="teams-connection-test">
            <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.ui.test_intro')}</p>
            <div className="flex items-center gap-3">
                <button
                    type="button" onClick={() => run.mutate()} disabled={busy}
                    className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-[13px] font-medium border disabled:opacity-40 border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-primary)]"
                >
                    {busy
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
                        : <Stethoscope className="w-3.5 h-3.5" aria-hidden="true" />}
                    {busy ? t('teams_setup.ui.testing') : report ? t('teams_setup.ui.test_again') : t('teams_setup.ui.test_my_connection')}
                </button>
                {error && <span role="alert" className="text-[12px] font-medium text-[var(--error-ink)]">{error}</span>}
            </div>
            {report && <DiagnosticsChecklist checks={report.checks} overall={report.overall} ranAt={report.ranAt} />}
        </div>
    );
}
