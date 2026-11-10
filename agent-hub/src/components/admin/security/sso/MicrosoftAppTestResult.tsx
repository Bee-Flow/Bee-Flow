import { useTranslation } from '@/hooks/useTranslation';
import DiagnosticsChecklist from '@/components/meetings/teamsSetup/DiagnosticsChecklist';
import type { TeamsDiagnosticsReport } from '@/components/meetings/teamsSetup/types';

/**
 * The checklist the Microsoft app registration test answers with (POST
 * /auth/providers/microsoft/test, `report`): whether the details are filled in, whether
 * Microsoft issues a token with the stored client ID and secret, and the redirect URIs to
 * check by hand. Nothing when the answer carried no report.
 */
export default function MicrosoftAppTestResult({ report }: { report?: TeamsDiagnosticsReport | null }) {
    const { t } = useTranslation();
    if (!report || !Array.isArray(report.checks)) return null;
    return (
        <section className="flex flex-col gap-2" aria-labelledby="ms-app-test-title" data-testid="ms-app-test-result">
            <div>
                <h4 id="ms-app-test-title" className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.ui.app_test_title')}</h4>
                <p className="m-0 text-xs text-[var(--text-secondary)]">{t('teams_setup.ui.app_test_intro')}</p>
            </div>
            <DiagnosticsChecklist checks={report.checks} overall={report.overall} ranAt={report.ranAt} />
        </section>
    );
}
