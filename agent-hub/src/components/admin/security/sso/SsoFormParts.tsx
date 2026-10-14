import type { CSSProperties, ReactNode } from 'react';
import type { SsoProviderConfig, SsoProviderId, SsoProvidersState } from './useSsoProviders';
import { useTranslation } from '../../../../hooks/useTranslation';

export const INPUT_STYLE: CSSProperties = { background: 'var(--bg-tertiary)', border: '1px solid var(--border-default)', color: 'var(--text-primary)' };
export const CARD = 'p-6 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]';
export const LABEL = 'block text-sm font-medium text-secondary mb-2';
export const CODE = 'bg-black/30 px-2 py-0.5 rounded text-xs font-mono';

/** Green "Active" or grey "Not configured" pill. */
export function ProviderStatus({ config }: { config: SsoProviderConfig | undefined }) {
    return (
        <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium ${config?.enabled ? 'bg-green-500/10 text-green-400' : 'bg-gray-500/10 text-gray-400'
            }`}>
            <span className={`w-1.5 h-1.5 rounded-full ${config?.enabled ? 'bg-green-400' : 'bg-gray-400'}`}></span>
            {config?.enabled ? 'Active' : 'Not configured'}
        </span>
    );
}

interface ProviderHeaderProps {
    logo: ReactNode;
    logoBackground: string;
    title: string;
    description: string;
    config: SsoProviderConfig;
}

export function ProviderHeader({ logo, logoBackground, title, description, config }: ProviderHeaderProps) {
    return (
        <div className="flex items-center gap-4 mb-6">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: logoBackground }}>
                {logo}
            </div>
            <div>
                <h3 className="text-lg font-semibold text-primary">{title}</h3>
                <p className="text-sm text-muted">{description}</p>
            </div>
            <ProviderStatus config={config} />
        </div>
    );
}

interface FieldProps {
    provider: SsoProviderId;
    sso: SsoProvidersState;
    label: ReactNode;
    placeholder: string;
}

/** The OAuth client id input. */
export function ClientIdField({ provider, sso, label, placeholder }: FieldProps) {
    return (
        <div>
            <label className={LABEL}>{label}</label>
            <input
                type="text"
                value={sso.providers[provider].clientId}
                onChange={(e) => sso.updateProviderField(provider, 'clientId', e.target.value)}
                placeholder={placeholder}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-mono"
                style={INPUT_STYLE}
            />
        </div>
    );
}

// What the secret input shows while no secret is stored (each provider's
// console names the value differently).
const SECRET_PLACEHOLDER: Record<SsoProviderId, string> = {
    nextcloud: 'OAuth Client Secret',
    google: 'OAuth Client Secret',
    microsoft: 'Client Secret Value',
};

/** The client secret input; the stored secret is never shown, only whether one is set. */
export function ClientSecretField({ provider, sso }: Pick<FieldProps, 'provider' | 'sso'>) {
    const { t } = useTranslation();
    const { providers, secrets, setSecrets } = sso;
    return (
        <div>
            <label className={LABEL}>
                {t('admin.sso_client_secret')} {providers[provider].clientSecretSet && <span className="text-green-400 text-xs">{t('admin.sso_secret_configured')}</span>}
            </label>
            <input
                type="password"
                value={secrets[provider]}
                onChange={(e) => setSecrets(prev => ({ ...prev, [provider]: e.target.value }))}
                placeholder={providers[provider].clientSecretSet ? t('admin.sso_secret_empty') : SECRET_PLACEHOLDER[provider]}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-mono"
                style={INPUT_STYLE}
            />
        </div>
    );
}

/** The numbered setup steps for one provider. */
export function SetupInstructions({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className={CARD}>
            <h4 className="font-semibold text-primary mb-3">{t('admin_security.sso_setup_title', '📋 Setup Instructions')}</h4>
            <ol className="text-sm text-secondary space-y-2 list-decimal list-inside">
                {children}
            </ol>
        </div>
    );
}

interface ProviderActionsProps {
    provider: SsoProviderId;
    sso: SsoProvidersState;
    /** The field the test needs before it can run. */
    canTest: boolean;
    testLabel: string;
}

/** Save and test/validate. */
export function ProviderActions({ provider, sso, canTest, testLabel }: ProviderActionsProps) {
    const { t } = useTranslation();
    const { saving, testing, handleSaveProvider, handleTestProvider } = sso;
    return (
        <div className="flex gap-3">
            <button onClick={() => handleSaveProvider(provider)} disabled={saving[provider]}
                className="px-5 py-2.5 rounded-lg text-sm font-medium text-white shadow-md bg-[var(--accent-primary)]">
                {saving[provider] ? t('admin.sso_saving') : t('admin.sso_save')}
            </button>
            <button onClick={() => handleTestProvider(provider)} disabled={testing[provider] || !canTest}
                className="px-5 py-2.5 rounded-lg text-sm font-medium border border-[var(--border-default)] text-[var(--text-secondary)] bg-[var(--bg-secondary)]">
                {testing[provider] ? t('admin.sso_testing') : testLabel}
            </button>
        </div>
    );
}
