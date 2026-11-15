import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Shield, KeyRound, Users, AtSign, Activity } from 'lucide-react';
import GuardrailsHub from './guardrails/GuardrailsHub';
import OrgGuardrails from './guardrails/OrgGuardrails';
import SSOConfigPanel from './SSOConfigPanel';
import FreeEmailDomainsPanel from '../org/FreeEmailDomainsPanel';
import ConnectorHealthPanel from '../../integrations/health/ConnectorHealthPanel';
import UserManagement from '../org/UserManagement';
import { useLicenseContext } from '../../licensing/LicenseContext';
import type { AdminCurrentUser } from '../org/userManagement/types';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import type { AdminScope } from '@/components/admin/dashboard/adminTabs';
import { homeOrgIdOf, isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import { ServerWideMark, serverWideLast } from '@/components/admin/dashboard/serverWideNav';
import AdminAccessDenied from '@/components/admin/dashboard/AdminAccessDenied';
import ChooseOrgNotice from '@/components/admin/dashboard/ChooseOrgNotice';
import Tabs from '@/components/shared/Tabs';
import { useShellProps } from '@/authedApp/useShellProps';

/**
 * SecurityHub — Unified security configuration page
 * Groups Users, Guardrails, SSO and the operator sections in a StudioShell
 * with a SectionNav sidebar; the section is the URL (admin/security/<id>).
 *
 * Guardrails always offers the per-organisation Privacy Shield; the server
 * console around it (patterns, Direct chat, ...) is Enterprise only (the
 * resolved tier is the REAL tier — LicenseContext.hasTier has no super-admin
 * elevation — so the operator's own UI hides it too).
 *
 * Beta features are no longer configured here — they moved to the unified
 * Access & Permissions hub (Admin → Access → Ceiling / Grants).
 */
const SECTIONS = [
    { id: 'users', labelKey: 'admin.sec_users', icon: Users },
    { id: 'guardrails', labelKey: 'admin.sec_guardrails', icon: Shield },
    { id: 'sso', labelKey: 'admin.sec_sso', icon: KeyRound },
    { id: 'email-domains', labelKey: 'admin.sec_email_domains', icon: AtSign },
    { id: 'connector-health', labelKey: 'admin.sec_connector_health', icon: Activity },
];

/**
 * The hub's own sections about the whole server. In the admin dashboard each is
 * a whole-server row now (Sign-in & SSO, Nextcloud instances), so the
 * dashboard's scope data no longer names them as Security sections.
 */
const SERVER_WIDE_SECTIONS: ReadonlySet<string> = new Set(['sso', 'email-domains', 'connector-health']);

/**
 * The scope of the rendered section, for the dashboard's scope bar. Guardrails
 * and Users report the scope of their own sub-section (GuardrailsHub,
 * UserManagement), so they answer null here.
 */
function securityScope(active: string, platformAdmin: boolean): AdminScope | null {
    if (active === 'guardrails' || active === 'users') return null;
    if (!platformAdmin) return 'org';
    return SERVER_WIDE_SECTIONS.has(active) ? 'instance' : 'mixed';
}

interface SecurityHubProps {
    activeSection?: string;
    userSection?: string;
    onNavigate?: (path: string) => void;
    user?: AdminCurrentUser | null;
    /**
     * false: no section column (the admin dashboard, whose rail rows are the
     * sections): the Privacy Shield, Sign-in & SSO and the Guardrail library,
     * one page each. Left out: the hub with its own section column.
     */
    nav?: boolean;
}

interface RowPageProps {
    section: string;
    part: string;
    user: AdminCurrentUser | null;
    go: ((path: string) => void) | undefined;
}

/** The Privacy Shield of the organisation the dashboard works on (a platform admin's choice, anyone else's home organisation). */
function PrivacyShieldPage({ user }: Pick<RowPageProps, 'user'>) {
    const platformAdmin = isPlatformAdmin(user);
    const choice = useAdminOrgChoice();
    useAdminScopeOverride('org');
    if (platformAdmin && !choice?.orgId) return <ChooseOrgNotice noOrgs={!!choice?.organizationsLoaded && choice.organizations.length === 0} />;
    const orgId = platformAdmin ? choice?.orgId ?? null : homeOrgIdOf(user);
    return <OrgGuardrails orgId={orgId} activityOrgId={platformAdmin ? orgId : null} />;
}

/** Sign-in & SSO: the providers, and the e-mail domains of every organisation on this server, as two tabs. */
function SsoPage({ part, go }: Pick<RowPageProps, 'part' | 'go'>) {
    const { t } = useTranslation();
    const active = part === 'email-domains' ? 'email-domains' : 'providers';
    useAdminScopeOverride('instance');
    return (
        <div className="space-y-5">
            <Tabs
                ariaLabel={t('admin_nav.sso', 'Sign-in & SSO')}
                value={active}
                onChange={(id) => go?.(id === 'email-domains' ? 'admin/security/sso/email-domains' : 'admin/security/sso')}
                items={[
                    { id: 'providers', label: t('admin_nav.sso_providers', 'Providers') },
                    { id: 'email-domains', label: t('admin_nav.sso_email_domains', 'Email domains') },
                ]}
            />
            {active === 'email-domains' ? <FreeEmailDomainsPanel /> : <SSOConfigPanel />}
        </div>
    );
}

/**
 * The security rows this viewer gets, in rail order: the same rules as the
 * rail's rows (dashboard/adminTabRows SECURITY_RAIL_ROWS).
 */
function securityRowsFor(user: AdminCurrentUser | null, enterprise: boolean): string[] {
    const platformAdmin = isPlatformAdmin(user);
    return [
        ...(platformAdmin || isHomeOrgAdmin(user) ? ['guardrails'] : []),
        ...(platformAdmin ? ['sso'] : []),
        ...(platformAdmin && enterprise ? ['guardrail-library'] : []),
    ];
}

/**
 * One security row of the admin dashboard: no section column, the rail is the
 * navigation. A section this viewer does not get opens the first one they do
 * (the row the rail marks), and none at all is the denied page, never an empty pane.
 */
function SecurityRowPage({ section, part, user, go }: RowPageProps) {
    const { hasTier } = useLicenseContext();
    const rows = securityRowsFor(user, !!hasTier('enterprise'));
    const open = rows.includes(section) ? section : rows[0];
    let body: ReactNode;
    if (open === 'guardrails') body = <PrivacyShieldPage user={user} />;
    else if (open === 'sso') body = <SsoPage part={part} go={go} />;
    else if (open === 'guardrail-library') body = <GuardrailsHub mode="library" section={open === section ? part : ''} onNavigate={go} />;
    else return <AdminAccessDenied scope="section" inSection />;
    return <div className="h-full overflow-auto"><div className="p-6 md:p-8">{body}</div></div>;
}

const SecurityHub = ({ activeSection: activeProp = 'users', userSection = '', onNavigate, user: userProp, nav = true }: SecurityHubProps) => {
    // Inside the app shell the signed-in person and the navigation come from
    // context; a host outside it (a test, a kit) still hands them as props.
    const { user, onNavigate: go } = useShellProps({ user: userProp, onNavigate });
    if (!nav) return <SecurityRowPage section={activeProp} part={userSection} user={user} go={go} />;
    return <SecurityHubWithNav activeProp={activeProp} userSection={userSection} user={user} go={go} />;
};

interface SecurityHubWithNavProps {
    activeProp: string;
    userSection: string;
    user: AdminCurrentUser | null;
    go: ((path: string) => void) | undefined;
}

/** The hub with its own section column. */
function SecurityHubWithNav({ activeProp, userSection, user, go }: SecurityHubWithNavProps) {
    const { t } = useTranslation();
    const { hasTier } = useLicenseContext();
    const isEnterprise = hasTier('enterprise');
    // The sections about the whole server (SSO, e-mail domains, connector
    // health) are for the platform operator only: their scope in adminTabs says
    // so, and the server-side gates require users.role === 'admin'. The 'all'
    // permission is deliberately NOT enough: it is obtainable inside a tenant.
    const platformAdmin = isPlatformAdmin(user);
    // The shield's organisation: a platform admin's dashboard choice (none = the editor's picker), anyone else's home organisation.
    const chosenOrgId = useAdminOrgChoice()?.orgId ?? null;
    const shieldOrgId = platformAdmin ? chosenOrgId : homeOrgIdOf(user);
    const visibleSections = SECTIONS
        .filter(s => platformAdmin || !SERVER_WIDE_SECTIONS.has(s.id))
        // The per-organisation shield is saved by an organisation admin of the home organisation
        // only (the server's strict check, utils/adminAccess isHomeOrgAdmin).
        .filter(s => s.id !== 'guardrails' || platformAdmin || isHomeOrgAdmin(user));
    const VALID_IDS = visibleSections.map(s => s.id);
    const active = VALID_IDS.includes(activeProp) ? activeProp : 'users';
    // The URL may name a section this viewer cannot see; the scope follows what is rendered.
    useAdminScopeOverride(securityScope(active, platformAdmin));

    return (
        <StudioShell
            responsive
            sidebarTitle={t('admin.tab_security')}
            sidebar={(
                <SectionNav
                    label={t('admin.tab_security')}
                    items={serverWideLast(visibleSections, sec => SERVER_WIDE_SECTIONS.has(sec.id)).map(sec => ({
                        id: sec.id,
                        icon: sec.icon,
                        label: t(sec.labelKey),
                        ...(sec.serverWide ? { group: t('admin.scope_instance', 'Whole server'), groupDivider: true, mark: <ServerWideMark /> } : {}),
                    }))}
                    activeId={active}
                    onSelect={(id) => { if (go) go(`admin/security/${id}`); }}
                />
            )}
        >
            {active === 'users' && (
                <div className="relative h-full">
                    <div className="absolute inset-0">
                        <UserManagement activeSection={userSection} onNavigate={go} user={user} />
                    </div>
                </div>
            )}
            {active === 'guardrails' && (
                <div className="p-6 md:p-8">
                    {/* `userSection` is the third admin path segment — the same one
                        ConnectorHealthPanel receives. Threading it here is what makes
                        /app/admin/security/guardrails/<section> a real, bookmarkable
                        URL without touching App.jsx's router. */}
                    {platformAdmin && isEnterprise
                        ? <GuardrailsHub section={userSection} onNavigate={go} />
                        : <OrgGuardrails orgId={shieldOrgId} activityOrgId={platformAdmin ? shieldOrgId : null} allowOrgPicker={platformAdmin} />}
                </div>
            )}
            {active === 'sso' && (
                <div className="p-6 md:p-8">
                    <SSOConfigPanel />
                </div>
            )}
            {active === 'email-domains' && (
                <div className="p-6 md:p-8">
                    <FreeEmailDomainsPanel />
                </div>
            )}
            {active === 'connector-health' && (
                <div className="p-6 md:p-8">
                    <ConnectorHealthPanel initialOrgId={userSection} onNavigate={go} />
                </div>
            )}
        </StudioShell>
    );
}

export default SecurityHub;
