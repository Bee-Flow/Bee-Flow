import { useState, useEffect, useMemo } from 'react';
import MicrosoftIdentityPanel from './MicrosoftIdentityPanel';
import MicrosoftSsoTab from './sso/MicrosoftSsoTab';
import { ProviderStatus } from './sso/SsoFormParts';
import { GoogleSsoTab, NextcloudSsoTab } from './sso/SsoProviderTabs';
import useSsoProviders from './sso/useSsoProviders';
import type { SsoProviderId, SsoProvidersState } from './sso/useSsoProviders';
import { useTranslation } from '../../../hooks/useTranslation';
import { useLicenseContext } from '../../licensing/LicenseContext';

interface NavItem {
    id: SsoProviderId;
    label: string;
    icon: string;
    color: string;
}

interface SidebarProps {
    navItems: NavItem[];
    activeTab: SsoProviderId;
    onSelect: (id: SsoProviderId) => void;
    providers: SsoProvidersState['providers'];
}

function SsoSidebar({ navItems, activeTab, onSelect, providers }: SidebarProps) {
    const { t } = useTranslation();
    return (
        <div className="w-64 flex flex-col p-2 border-r border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <div className="p-4 mb-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('admin_security.sso_providers_title', 'SSO Providers')}</h3>
            </div>
            <div className="space-y-1">
                {navItems.map(item => (
                    <button
                        key={item.id}
                        onClick={() => onSelect(item.id)}
                        className={`w-full flex items-center justify-between px-4 py-3 rounded-lg text-sm font-medium transition-all text-left ${activeTab === item.id
                            ? 'bg-[var(--accent-primary)] text-white shadow-md'
                            : 'text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]'
                            }`}
                    >
                        <div className="flex items-center gap-3">
                            <span className="text-lg">{item.icon}</span>
                            {item.label}
                        </div>
                        {activeTab !== item.id && <ProviderStatus config={providers[item.id]} />}
                    </button>
                ))}
            </div>

            {/* Overall Status */}
            <div className="mt-auto p-4 border-t" style={{ borderColor: 'var(--border-default)' }}>
                <p className="text-xs text-muted mb-2">{t('admin_security.sso_configured_providers', 'Configured providers')}</p>
                <div className="flex gap-2 flex-wrap">
                    {Object.entries(providers).filter(([_, v]) => v.enabled).map(([key]) => (
                        <span key={key} className="px-2 py-1 rounded text-xs bg-green-500/10 text-green-400 capitalize">{key}</span>
                    ))}
                    {!Object.values(providers).some(p => p.enabled) && (
                        <span className="text-xs text-muted">{t('admin_security.sso_none', 'None')}</span>
                    )}
                </div>
            </div>
        </div>
    );
}

const SSOConfigPanel = () => {
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
        { id: 'nextcloud', label: 'Nextcloud', icon: '☁️', color: '#0082c9' },
        // Google / Microsoft require the `sso_saml` enterprise feature.
        ...(ssoSaml ? [
            { id: 'google' as const, label: 'Google', icon: '🔍', color: '#4285f4' },
            { id: 'microsoft' as const, label: 'Microsoft', icon: '🪟', color: '#00a4ef' },
        ] : []),
    ], [ssoSaml]);

    // If a non-Community deep link / stale state lands on an enterprise
    // provider tab that's now hidden, fall back to Nextcloud so the enterprise
    // config form never renders on Community.
    useEffect(() => {
        if (!navItems.some(n => n.id === activeTab)) setActiveTab('nextcloud');
    }, [navItems, activeTab]);

    if (loading) {
        return (
            <div className="flex h-full border rounded-xl overflow-hidden shadow-sm border-[var(--border-default)] bg-[var(--bg-secondary)]">
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-muted">Loading...</div>
                </div>
            </div>
        );
    }

    return (
        <div className="flex h-full border rounded-xl overflow-hidden shadow-sm border-[var(--border-default)] bg-[var(--bg-secondary)]">
            <SsoSidebar
                navItems={navItems}
                activeTab={activeTab}
                onSelect={(id) => { setActiveTab(id); setMessage(null); }}
                providers={providers}
            />

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-8 bg-[var(--bg-primary)]">
                {message && (
                    <div className={`mb-6 p-3 rounded-lg text-sm ${message.type === 'success'
                        ? 'bg-green-500/10 text-green-400 border border-green-500/20'
                        : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}>
                        {message.text}
                    </div>
                )}

                {activeTab === 'nextcloud' && <NextcloudSsoTab sso={sso} />}
                {activeTab === 'google' && <GoogleSsoTab sso={sso} />}
                {activeTab === 'microsoft' && <MicrosoftSsoTab sso={sso} />}
            </div>
            {activeTab === 'microsoft' && <MicrosoftIdentityPanel />}
        </div>
    );
};

export default SSOConfigPanel;
