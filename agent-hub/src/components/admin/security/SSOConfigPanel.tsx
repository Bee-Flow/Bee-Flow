import { useState, useMemo } from 'react';
import MicrosoftSsoTab from './sso/MicrosoftSsoTab';
import { GoogleSsoTab, NextcloudSsoTab } from './sso/SsoProviderTabs';
import useSsoProviders from './sso/useSsoProviders';
import type { SsoProviderId, SsoProvidersState } from './sso/useSsoProviders';
import { useTranslation } from '@/hooks/useTranslation';
import { useLicenseContext } from '../../licensing/LicenseContext';
import { ALERT_ERROR, ALERT_SUCCESS } from '@/components/shared/adminUi';
import { DetailLayout, DetailListGroup, DetailListNav, DetailListRow } from '@/components/shared/DetailList';
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

const NEXTCLOUD: NavItem = { id: 'nextcloud', label: 'Nextcloud', icon: '☁️' };
const GOOGLE: NavItem = { id: 'google', label: 'Google', icon: '🔍' };
const MICROSOFT: NavItem = { id: 'microsoft', label: 'Microsoft', icon: '🪟' };

/** Nextcloud sign-in is in use: switched on, or pointed at a Nextcloud already. */
function nextcloudInUse(providers: SsoProvidersState['providers']): boolean {
    return !!providers.nextcloud?.enabled || !!providers.nextcloud?.url;
}

/**
 * The providers in list order. Google and Microsoft need the `sso_saml`
 * enterprise feature; Nextcloud leads only on a server that signs in with it,
 * and comes last on one that has never been pointed at a Nextcloud.
 */
function ssoNavItems(ssoSaml: boolean, providers: SsoProvidersState['providers']): NavItem[] {
    if (!ssoSaml) return [NEXTCLOUD];
    return nextcloudInUse(providers) ? [NEXTCLOUD, GOOGLE, MICROSOFT] : [GOOGLE, MICROSOFT, NEXTCLOUD];
}

/** The provider the page opens on: the first enabled one in list order, else the first listed. */
function defaultSsoTab(navItems: readonly NavItem[], providers: SsoProvidersState['providers']): SsoProviderId {
    return (navItems.find(item => providers[item.id]?.enabled) ?? navItems[0]).id;
}

/**
 * The sign-in providers of the whole server, one form each beside the list.
 * The admin dashboard's page frame draws the page header (Sign-in & SSO), so
 * the panel has no title or width of its own.
 */
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
    // The list order and the opening provider follow the configuration as it
    // was read, not the form being typed in, so nothing moves while editing;
    // a provider the admin picks stays open.
    const [stored, setStored] = useState<SsoProvidersState['providers'] | null>(null);
    if (!loading && stored === null) setStored(providers);
    const basis = stored ?? providers;
    const navItems = useMemo<NavItem[]>(() => ssoNavItems(ssoSaml, basis), [ssoSaml, basis]);
    const [picked, setPicked] = useState<SsoProviderId | null>(null);
    // A deep link / stale choice of an enterprise provider that is now hidden
    // falls back to the default, so the enterprise config form never renders on Community.
    const activeTab: SsoProviderId = picked && navItems.some(n => n.id === picked) ? picked : defaultSsoTab(navItems, basis);

    if (loading) {
        return <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)]"><Spinner size="sm" /> {t('common.loading', 'Loading...')}</div>;
    }

    return (
        <DetailLayout
            list={(
                <SsoSidebar
                    navItems={navItems}
                    activeTab={activeTab}
                    onSelect={(id) => { setPicked(id); setMessage(null); }}
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
            </div>
        </DetailLayout>
    );
};

export default SSOConfigPanel;
