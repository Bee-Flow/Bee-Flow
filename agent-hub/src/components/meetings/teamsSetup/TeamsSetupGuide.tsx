import { BookOpen, ExternalLink } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { useTeamsRequirements } from '@/api/queries/teamsSetup';
import { purposeText, roleText } from './checkText';
import type { PermissionRow, TeamsRequirements } from './types';

const TEAMS_SETUP_DOCS_URL = 'https://docs.beeflow.ai/integrations/teams-meeting-notes';

const CODE = 'rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--text-primary)]';
const CARD = 'rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-4 py-3';
const SUBTITLE = 'text-[12px] font-semibold text-[var(--text-primary)]';

type Who = 'platform_admin' | 'org_admin' | 'entra_admin' | 'teams_admin' | 'member';

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
function Steps({ steps }: { steps: Array<{ text: string; who: Who }> }) {
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
        <div className="mt-2">
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
        <div className="mt-2">
            <p className={SUBTITLE}>{t('teams_setup.guide.redirect_uris')}</p>
            <ul className="mt-1 flex flex-col gap-1 text-[12px]">
                <li><code className={CODE}>{uris.signIn}</code></li>
                <li><code className={CODE}>{uris.connect}</code></li>
            </ul>
        </div>
    );
}

/**
 * How to set up Teams meeting notes, for the organisation admin: the two supported ways
 * (per organiser with delegated permissions, organisation-wide with application
 * permissions), what is not supported, the steps with who does each one, and the
 * permissions and redirect URIs the app registration needs (GET /api/teams-setup/requirements).
 */
export default function TeamsSetupGuide() {
    const { t } = useTranslation();
    const requirements = useTeamsRequirements();
    const req = requirements.data;

    const stepsA: Array<{ text: string; who: Who }> = [
        { text: t('teams_setup.guide.step_app'), who: 'platform_admin' },
        { text: t('teams_setup.guide.step_permissions'), who: 'platform_admin' },
        { text: t('teams_setup.guide.step_consent'), who: 'entra_admin' },
        { text: t('teams_setup.guide.step_teams_switches'), who: 'teams_admin' },
        { text: t('teams_setup.guide.step_connect'), who: 'member' },
        { text: t('teams_setup.guide.step_auto_import'), who: 'org_admin' },
    ];
    const stepsB: Array<{ text: string; who: Who }> = [
        { text: t('teams_setup.guide.b_step_permissions'), who: 'entra_admin' },
        { text: t('teams_setup.guide.b_step_policy'), who: 'teams_admin' },
        { text: t('teams_setup.guide.b_step_tenant'), who: 'platform_admin' },
        { text: t('teams_setup.guide.b_step_enable'), who: 'org_admin' },
    ];

    return (
        <section className="flex flex-col gap-3" aria-labelledby="teams-setup-guide-title" data-testid="teams-setup-guide">
            <div>
                <h4 id="teams-setup-guide-title" className="text-[13px] font-semibold text-[var(--text-primary)]">{t('teams_setup.guide.title')}</h4>
                <p className="text-[12px] text-[var(--text-muted)]">{t('teams_setup.guide.intro')}</p>
            </div>

            <div className={CARD} data-testid="teams-setup-option-a">
                <p className={SUBTITLE}>{t('teams_setup.guide.option_a_title')}</p>
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.guide.option_a_desc')}</p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('teams_setup.guide.option_a_needs')}</p>
                <Steps steps={stepsA} />
                {req && (
                    <>
                        <PermissionList title={t('teams_setup.guide.permissions_delegated')} rows={req.delegated} />
                        <RedirectUris uris={req.redirectUris} />
                    </>
                )}
            </div>

            <div className={CARD} data-testid="teams-setup-option-b">
                <p className={SUBTITLE}>{t('teams_setup.guide.option_b_title')}</p>
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.guide.option_b_desc')}</p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('teams_setup.guide.option_b_needs')}</p>
                <Steps steps={stepsB} />
                {req && <PermissionList title={t('teams_setup.guide.permissions_application')} rows={req.application} />}
            </div>

            <div className={CARD}>
                <p className={SUBTITLE}>{t('teams_setup.guide.other_title')}</p>
                <p className="text-[12px] text-[var(--text-secondary)]">{t('teams_setup.guide.other_desc')}</p>
            </div>

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
