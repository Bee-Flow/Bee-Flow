import type { ReactNode } from 'react';
import { BookOpen, ExternalLink } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useTeamsOrgOverview, useTeamsRequirements } from '@/api/queries/teamsSetup';
import { useTeamsAppImport } from '@/api/queries/teamsAppImport';
import { CHIP, CHIP_INFO, CHIP_SUCCESS, CHIP_WARNING } from '@/components/shared/adminUi';
import { purposeText, roleText } from './checkText';
import type { PermissionRow, TeamsRequirements } from './types';

const TEAMS_SETUP_DOCS_URL = 'https://docs.beeflow.ai/integrations/teams-meeting-notes';

/** The window the members overview and organisation-wide import ask for; the same key shares their cache. */
const OVERVIEW_DAYS = 7;

const CODE = 'rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]';
const CARD = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3';
const SUBTITLE = 'text-[12px] font-semibold text-[var(--text-primary)]';

type Who = 'platform_admin' | 'org_admin' | 'entra_admin' | 'teams_admin' | 'member';
type Step = { text: string; who: Who };

function whoText(t: TranslateFn, who: Who): string {
    switch (who) {
        case 'platform_admin': return t('teams_setup.guide.who_platform_admin');
        case 'org_admin': return t('teams_setup.guide.who_org_admin');
        case 'entra_admin': return t('teams_setup.guide.who_entra_admin');
        case 'teams_admin': return t('teams_setup.guide.who_teams_admin');
        default: return t('teams_setup.guide.who_member');
    }
}

/** One numbered step with the person who does it. */
function Steps({ steps }: { steps: Step[] }) {
    const { t } = useTranslation();
    return (
        <ol className="mt-2 flex flex-col gap-1.5 list-decimal pl-5 text-[12px] text-[var(--text-primary)]">
            {steps.map((s) => (
                <li key={s.text}>
                    {s.text}
                    <span className="ml-1.5 inline-block rounded-full px-2 py-0.5 text-[10px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-muted)]">{whoText(t, s.who)}</span>
                </li>
            ))}
        </ol>
    );
}

/** The permissions the app registration needs, with what each is for and whether it needs admin consent. */
function PermissionList({ title, rows }: { title: string; rows: PermissionRow[] }) {
    const { t } = useTranslation();
    if (rows.length === 0) return null;
    return (
        <div className="mt-3">
            <p className={SUBTITLE}>{title}</p>
            <ul className="mt-1 flex flex-col gap-1 text-[12px]">
                {rows.map((row) => (
                    <li key={`${row.kind}:${row.name}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-permission={row.name}>
                        <code className={CODE}>{row.name}</code>
                        <span className={row.role === 'requested' ? 'text-[var(--text-muted)]' : 'font-medium text-[var(--text-primary)]'}>{roleText(t, row.role)}</span>
                        <span className="text-[var(--text-muted)]">{purposeText(t, row.purpose)}</span>
                        {row.adminConsent && <span className="text-[11px] font-medium text-[var(--warning-ink)]">{t('teams_setup.ui.needs_admin_consent')}</span>}
                    </li>
                ))}
            </ul>
        </div>
    );
}

function RedirectUris({ uris }: { uris: TeamsRequirements['redirectUris'] }) {
    const { t } = useTranslation();
    return (
        <div className="mt-3">
            <p className={SUBTITLE}>{t('teams_setup.guide.redirect_uris')}</p>
            <ul className="mt-1 flex flex-col gap-1 text-[12px]">
                <li><code className={CODE}>{uris.signIn}</code></li>
                <li><code className={CODE}>{uris.connect}</code></li>
            </ul>
        </div>
    );
}

/** How many members connected their own account. Left out while unknown, or when the list was cut short. */
function OwnAccountStatus() {
    const { t } = useTranslation();
    const overview = useTeamsOrgOverview(OVERVIEW_DAYS).data;
    if (!overview || overview.truncated) return null;
    const { connected, members } = overview.totals;
    return (
        <span className={connected > 0 ? CHIP_SUCCESS : CHIP} data-testid="teams-own-account-status">
            {t('teams_setup.guide.status_connected', { connected, members })}
        </span>
    );
}

/** Whether organisation-wide import is on, off, or cannot be switched on yet. Left out while unknown. */
function OrgImportStatus() {
    const { t } = useTranslation();
    const state = useTeamsAppImport().data;
    if (!state) return null;
    let look = CHIP;
    let text = t('teams_setup.guide.status_off');
    if (state.settings.enabled) {
        look = CHIP_SUCCESS;
        text = t('teams_setup.guide.status_on', { covered: state.counts.covered });
    } else if (state.availability.reason !== 'ok') {
        look = CHIP_WARNING;
        text = t('teams_setup.guide.status_unavailable');
    }
    return <span className={look} data-testid="teams-org-import-status">{text}</span>;
}

interface WayCardProps {
    testId: string;
    title: string;
    description: string;
    /** Beside the title: a "start here" mark and where this way stands now. */
    marks: ReactNode;
    membersDo: string;
    adminsDo: string;
    /** The setup steps, permissions and addresses: folded away until asked for. */
    details: ReactNode;
    /** What the organisation admin does for this way on this page (the approval link, the switch). */
    children?: ReactNode;
}

/** One way to reach the meetings: what it is, who has to do what, the steps on request, then the action. */
function WayCard({ testId, title, description, marks, membersDo, adminsDo, details, children }: WayCardProps) {
    const { t } = useTranslation();
    return (
        <div className={CARD} data-testid={testId}>
            <div className="flex flex-wrap items-center gap-2">
                <h5 className="m-0 text-[13px] font-semibold text-[var(--text-primary)]">{title}</h5>
                {marks}
            </div>
            <p className="mt-1 text-[12px] text-[var(--text-secondary)]">{description}</p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                <dt className="font-medium text-[var(--text-primary)]">{t('teams_setup.guide.members_do')}</dt>
                <dd className="m-0 text-[var(--text-secondary)]">{membersDo}</dd>
                <dt className="font-medium text-[var(--text-primary)]">{t('teams_setup.guide.admins_do')}</dt>
                <dd className="m-0 text-[var(--text-secondary)]">{adminsDo}</dd>
            </dl>
            <details className="mt-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                <summary className="cursor-pointer px-3 py-2 text-[12px] font-medium text-[var(--text-primary)]">{t('teams_setup.guide.show_steps')}</summary>
                <div className="border-t border-[var(--border-subtle)] px-3 pb-3 pt-1">{details}</div>
            </details>
            {children && <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">{children}</div>}
        </div>
    );
}

interface TeamsSetupGuideProps {
    /** Drawn inside "Members connect their own account": the approval link for Microsoft. */
    consent?: ReactNode;
    /** Drawn inside "Organisation-wide import": its switch, who it covers and its test. */
    appImport?: ReactNode;
}

/**
 * The two ways Bee Flow can reach members' Teams meetings, for the organisation admin, each
 * with a plain name, where it stands now, who has to do what, and the setup steps folded
 * away until asked for:
 *   - members connect their own account (Microsoft: delegated permissions), the place to start;
 *   - organisation-wide import (Microsoft: application permissions), for when members should
 *     not have to connect.
 * The action of each way (approval link, the organisation-wide switch) is drawn inside its
 * card. Then what is not supported and the link to the full guide. The permissions and
 * redirect URIs come from GET /api/teams-setup/requirements.
 */
export default function TeamsSetupGuide({ consent, appImport }: TeamsSetupGuideProps) {
    const { t } = useTranslation();
    const requirements = useTeamsRequirements();
    const req = requirements.data;

    const ownSteps: Step[] = [
        { text: t('teams_setup.guide.step_app'), who: 'platform_admin' },
        { text: t('teams_setup.guide.step_permissions'), who: 'platform_admin' },
        { text: t('teams_setup.guide.step_consent'), who: 'entra_admin' },
        { text: t('teams_setup.guide.step_teams_switches'), who: 'teams_admin' },
        { text: t('teams_setup.guide.step_connect'), who: 'member' },
        { text: t('teams_setup.guide.step_auto_import_where'), who: 'org_admin' },
    ];
    const orgSteps: Step[] = [
        { text: t('teams_setup.guide.b_step_permissions'), who: 'entra_admin' },
        { text: t('teams_setup.guide.b_step_policy'), who: 'teams_admin' },
        { text: t('teams_setup.guide.b_step_tenant'), who: 'platform_admin' },
        { text: t('teams_setup.guide.b_step_enable'), who: 'org_admin' },
    ];

    return (
        <section className="flex flex-col gap-3" aria-labelledby="teams-setup-guide-title" data-testid="teams-setup-guide">
            <div>
                <h4 id="teams-setup-guide-title" className="text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.guide.choose_title')}</h4>
                <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.guide.choose_intro')}</p>
            </div>

            <WayCard
                testId="teams-setup-option-a"
                title={t('teams_setup.guide.own_title')}
                description={t('teams_setup.guide.own_desc')}
                marks={<><span className={CHIP_INFO}>{t('teams_setup.guide.own_badge')}</span><OwnAccountStatus /></>}
                membersDo={t('teams_setup.guide.own_members_do')}
                adminsDo={t('teams_setup.guide.own_admins_do')}
                details={(
                    <>
                        <Steps steps={ownSteps} />
                        {req && (
                            <>
                                <PermissionList title={t('teams_setup.guide.permissions_delegated')} rows={req.delegated} />
                                <RedirectUris uris={req.redirectUris} />
                            </>
                        )}
                    </>
                )}
            >
                {consent}
            </WayCard>

            <WayCard
                testId="teams-setup-option-b"
                title={t('teams_setup.guide.org_title')}
                description={t('teams_setup.guide.org_desc')}
                marks={<OrgImportStatus />}
                membersDo={t('teams_setup.guide.org_members_do')}
                adminsDo={t('teams_setup.guide.org_admins_do')}
                details={(
                    <>
                        <Steps steps={orgSteps} />
                        {req && <PermissionList title={t('teams_setup.guide.permissions_application')} rows={req.application} />}
                    </>
                )}
            >
                {appImport}
            </WayCard>

            <p className="text-[12px] text-[var(--text-muted)]">
                <span className="font-medium text-[var(--text-secondary)]">{t('teams_setup.guide.other_title')}:</span> {t('teams_setup.guide.other_desc')}
            </p>

            <a
                href={TEAMS_SETUP_DOCS_URL} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 self-start text-[12px] font-medium text-[var(--info-ink)] hover:underline"
            >
                <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
                {t('teams_setup.guide.docs_link')}
                <ExternalLink className="w-3 h-3" aria-hidden="true" />
            </a>
        </section>
    );
}
