import React from 'react';
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
import { adminSectionScope, isAdminSectionVisible, type AdminScope } from '@/components/admin/dashboard/adminTabs';
import { homeOrgIdOf, isHomeOrgAdmin, isPlatformAdmin } from '@/utils/adminAccess';
import { useAdminOrgChoice } from '@/components/admin/dashboard/useAdminOrg';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import { ServerWideMark, serverWideLast } from '@/components/admin/dashboard/serverWideNav';

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
 * The scope of the rendered section, for the dashboard's scope bar. Guardrails
 * and Users report the scope of their own sub-section (GuardrailsHub,
 * UserManagement), so they answer null here.
 */
function securityScope(active: string, platformAdmin: boolean): AdminScope | null {
    if (active === 'guardrails' || active === 'users') return null;
    return platformAdmin ? adminSectionScope('security', active) : 'org';
}

interface SecurityHubProps {
    activeSection?: string;
    userSection?: string;
    onNavigate?: (path: string) => void;
    user?: AdminCurrentUser | null;
}

const SecurityHub = ({ activeSection: activeProp = 'users', userSection = '', onNavigate, user }: SecurityHubProps) => {
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
        .filter(s => isAdminSectionVisible('security', platformAdmin, s.id))
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
                    items={serverWideLast(visibleSections, sec => adminSectionScope('security', sec.id) === 'instance').map(sec => ({
                        id: sec.id,
                        icon: sec.icon,
                        label: t(sec.labelKey),
                        ...(sec.serverWide ? { group: t('admin.scope_instance', 'Whole server'), groupDivider: true, mark: <ServerWideMark /> } : {}),
                    }))}
                    activeId={active}
                    onSelect={(id) => { if (onNavigate) onNavigate(`admin/security/${id}`); }}
                />
            )}
        >
            {active === 'users' && (
                <div className="relative h-full">
                    <div className="absolute inset-0">
                        <UserManagement activeSection={userSection} onNavigate={onNavigate} user={user} />
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
                        ? <GuardrailsHub section={userSection} onNavigate={onNavigate} />
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
                    <ConnectorHealthPanel initialOrgId={userSection} onNavigate={onNavigate} />
                </div>
            )}
        </StudioShell>
    );
};

export default SecurityHub;
