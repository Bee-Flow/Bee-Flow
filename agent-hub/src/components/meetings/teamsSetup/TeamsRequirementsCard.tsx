import type { ReactNode } from 'react';
import { ClipboardCheck } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { useTeamsRequirements } from '@/api/queries/teamsSetup';
import { CHIP_SUCCESS } from '@/components/shared/adminUi';

const GROUP_TITLE = 'text-[12px] font-semibold text-[var(--text-primary)]';
const LIST = 'mt-1 flex list-disc flex-col gap-1 pl-5 text-[12px] text-[var(--text-secondary)]';

function Needs({ title, testId, children }: { title: string; testId: string; children: ReactNode }) {
    return (
        <div data-testid={testId}>
            <p className={GROUP_TITLE}>{title}</p>
            <ul className={LIST}>{children}</ul>
        </div>
    );
}

/**
 * What one member needs before Bee Flow can turn their Teams meetings into notes, in the
 * organisation admin's words: the Bee Flow side (plan, Meeting Notes access, no admin role),
 * the Microsoft side (account and licence, being the organiser, a recording, OneDrive) and
 * a way for Bee Flow to reach the meetings, which the guide below it offers.
 *
 * The plan line is ticked when GET /api/teams-setup/requirements answers: that request sits
 * behind the Meeting Notes module and licence, so an answer proves both.
 */
export default function TeamsRequirementsCard() {
    const { t } = useTranslation();
    const planProven = useTeamsRequirements().isSuccess;

    return (
        <section
            className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-5 py-4"
            aria-labelledby="teams-requirements-title" data-testid="teams-requirements"
        >
            <h4 id="teams-requirements-title" className="flex items-center gap-2 text-[13px] font-semibold text-[var(--text-primary)]">
                <ClipboardCheck className="w-4 h-4 text-[var(--accent-secondary)]" aria-hidden="true" />
                {t('teams_setup.needs.title')}
            </h4>
            <p className="mt-1 text-[12px] text-[var(--text-muted)]">{t('teams_setup.needs.intro')}</p>

            <div className="mt-3 grid gap-4 sm:grid-cols-2">
                <Needs title={t('teams_setup.needs.beeflow_title')} testId="teams-needs-beeflow">
                    <li>
                        {t('teams_setup.needs.plan')}
                        {planProven && <span className={`ml-1.5 ${CHIP_SUCCESS}`}>{t('teams_setup.needs.plan_ok')}</span>}
                    </li>
                    <li>{t('teams_setup.needs.access')}</li>
                    <li>{t('teams_setup.needs.role')}</li>
                </Needs>
                <Needs title={t('teams_setup.needs.microsoft_title')} testId="teams-needs-microsoft">
                    <li>{t('teams_setup.needs.account')}</li>
                    <li>{t('teams_setup.needs.organiser')}</li>
                    <li>{t('teams_setup.needs.recording')}</li>
                    <li>{t('teams_setup.needs.storage')}</li>
                </Needs>
            </div>

            <div className="mt-3">
                <p className={GROUP_TITLE}>{t('teams_setup.needs.connection_title')}</p>
                <p className="mt-1 text-[12px] text-[var(--text-secondary)]">{t('teams_setup.needs.connection')}</p>
            </div>
            <p className="mt-3 text-[11px] text-[var(--text-muted)]">{t('teams_setup.needs.not_needed')}</p>
        </section>
    );
}
