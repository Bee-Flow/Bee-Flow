import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Shield, KeyRound, Users, AtSign, Activity } from 'lucide-react';
import GuardrailsHub from './guardrails/GuardrailsHub';
import SSOConfigPanel from './SSOConfigPanel';
import FreeEmailDomainsPanel from '../org/FreeEmailDomainsPanel';
import ConnectorHealthPanel from '../../integrations/health/ConnectorHealthPanel';
import UserManagement from '../org/UserManagement';
import { useLicenseContext } from '../../licensing/LicenseContext';
import type { AdminCurrentUser } from '../org/userManagement/types';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';

/**
 * SecurityHub — Unified security configuration page
 * Groups Users, Guardrails, SSO and the operator sections in a StudioShell
 * with a SectionNav sidebar; the section is the URL (admin/security/<id>).
 *
 * `enterpriseOnly` sections are hidden on Community installs (the resolved
 * tier is the REAL tier — LicenseContext.hasTier has no super-admin
 * elevation — so the operator's own UI hides them too).
 *
 * Beta features are no longer configured here — they moved to the unified
 * Access & Permissions hub (Admin → Access → Ceiling / Grants).
 */
const SECTIONS = [
    { id: 'users', labelKey: 'admin.sec_users', icon: Users },
    { id: 'guardrails', labelKey: 'admin.sec_guardrails', icon: Shield, enterpriseOnly: true },
    { id: 'sso', labelKey: 'admin.sec_sso', icon: KeyRound },
    { id: 'email-domains', labelKey: 'admin.sec_email_domains', icon: AtSign, superAdminOnly: true },
    { id: 'connector-health', labelKey: 'admin.sec_connector_health', icon: Activity, superAdminOnly: true },
];

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
    // Platform operator only. The 'all' permission is deliberately NOT enough —
    // it is obtainable inside a tenant, and the server-side gates on these
    // sections (SSO config, email domains, connector health) require
    // users.role === 'admin'. See AdminDashboard's isSuperAdmin.
    const isFullAdmin = user?.isAdmin || user?.role === 'admin';
    const visibleSections = (isFullAdmin ? SECTIONS : SECTIONS.filter(s => !s.superAdminOnly && s.id !== 'sso'))
        .filter(s => !s.enterpriseOnly || isEnterprise);
    const VALID_IDS = visibleSections.map(s => s.id);
    const active = VALID_IDS.includes(activeProp) ? activeProp : 'users';

    return (
        <StudioShell
            responsive
            sidebarTitle={t('admin.tab_security')}
            sidebar={(
                <SectionNav
                    label={t('admin.tab_security')}
                    items={visibleSections.map(sec => ({ id: sec.id, icon: sec.icon, label: t(sec.labelKey) }))}
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
                    <GuardrailsHub section={userSection} onNavigate={onNavigate} />
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
