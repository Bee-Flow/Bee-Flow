import { useState, useEffect, useMemo } from 'react';
import MicrosoftIdentityPanel from './MicrosoftIdentityPanel';
import MicrosoftSsoTab from './sso/MicrosoftSsoTab';
import { GoogleSsoTab, NextcloudSsoTab } from './sso/SsoProviderTabs';
import useSsoProviders from './sso/useSsoProviders';
import type { SsoProviderId, SsoProvidersState } from './sso/useSsoProviders';
import { useTranslation } from '@/hooks/useTranslation';
import { useLicenseContext } from '../../licensing/LicenseContext';
import { ALERT_ERROR, ALERT_SUCCESS } from '@/components/mcpLibrary/ui';
import { DetailLayout, DetailListGroup, DetailListNav, DetailListRow } from '@/components/shared/DetailList';
import SectionHeader from '@/components/shared/SectionHeader';
import Spinner from '@/components/shared/Spinner';

interface NavItem {
    id: SsoProviderId;
    label: string;
    icon: string;
}

interface SidebarProps {
    navItems: NavItem[];
    activeTab: SsoProviderId;
    onSelect: (id: SsoProviderId) => void;
    providers: SsoProvidersState['providers'];
}

/** The providers as a list: a dot when a provider is enabled. */
function SsoSidebar({ navItems, activeTab, onSelect, providers }: SidebarProps) {
    const { t } = useTranslation();
    const title = t('admin_security.sso_providers_title', 'SSO Providers');
    return (
        <DetailListNav label={title}>
            <DetailListGroup title={title} count={navItems.filter(item => providers[item.id]?.enabled).length}>
                {navItems.map(item => (
                    <DetailListRow
                        key={item.id}
                        icon={item.icon}
                        name={item.label}
                        live={!!providers[item.id]?.enabled}
                        active={activeTab === item.id}
                        onClick={() => onSelect(item.id)}
                    />
                ))}
            </DetailListGroup>
        </DetailListNav>
    );
}

const SSOConfigPanel = () => {
    const { t } = useTranslation();
    // SSO tiering: Nextcloud OAuth login is Community (`nextcloud_oauth`);
    // Google / Microsoft / SAML SSO are Enterprise (`sso_saml`). On Community
    // only the Nextcloud provider is shown (the server also 403s the
    // Google/Microsoft config + login routes). The resolved tier is the real
    // tier, so a Community operator's own UI hides the enterprise providers.
    const hasFeature: (name: string) => boolean = useLicenseContext().hasFeature;
    const ssoSaml = hasFeature('sso_saml');
    const sso = useSsoProviders();
    const { providers, loading, message, setMessage } = sso;
    const [activeTab, setActiveTab] = useState<SsoProviderId>('nextcloud');

    const navItems = useMemo<NavItem[]>(() => [
        { id: 'nextcloud', label: 'Nextcloud', icon: '☁️' },
        // Google / Microsoft require the `sso_saml` enterprise feature.
        ...(ssoSaml ? [
            { id: 'google' as const, label: 'Google', icon: '🔍' },
            { id: 'microsoft' as const, label: 'Microsoft', icon: '🪟' },
        ] : []),
    ], [ssoSaml]);

    // If a non-Community deep link / stale state lands on an enterprise
    // provider tab that's now hidden, fall back to Nextcloud so the enterprise
    // config form never renders on Community.
    if (activeTab !== 'nextcloud' && !navItems.some(n => n.id === activeTab)) setActiveTab('nextcloud');

    const header = (
        <SectionHeader
            title={t('admin.sec_sso')}
            description={t('admin_security.sso_section_hint', 'Let people sign in with an account they already have.')}
        />
    );

    if (loading) {
        return (
            <div className="flex max-w-5xl flex-col gap-6">
                {header}
                <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Spinner size="sm" /> {t('common.loading', 'Loading...')}</div>
            </div>
        );
    }

    return (
        <div className="flex max-w-5xl flex-col gap-6">
            {header}
            <DetailLayout
                list={(
                    <SsoSidebar
                        navItems={navItems}
                        activeTab={activeTab}
                        onSelect={(id) => { setActiveTab(id); setMessage(null); }}
                        providers={providers}
                    />
                )}
            >
                <div className="overflow-y-auto">
                    {message && (
                        <div role="status" className={`mb-4 ${message.type === 'success' ? ALERT_SUCCESS : ALERT_ERROR}`}>
                            {message.text}
                        </div>
                    )}

                    {activeTab === 'nextcloud' && <NextcloudSsoTab sso={sso} />}
                    {activeTab === 'google' && <GoogleSsoTab sso={sso} />}
                    {activeTab === 'microsoft' && <MicrosoftSsoTab sso={sso} />}
                    {activeTab === 'microsoft' && <MicrosoftIdentityPanel />}
                </div>
            </DetailLayout>
        </div>
    );
};

export default SSOConfigPanel;
