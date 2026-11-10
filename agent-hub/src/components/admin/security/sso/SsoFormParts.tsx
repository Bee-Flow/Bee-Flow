import type { ReactNode } from 'react';
import { CHIP, CHIP_SUCCESS, DOT_LIVE, DOT_OFF, PRIMARY_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import type { SsoProviderConfig, SsoProviderId, SsoProvidersState } from './useSsoProviders';
import { useTranslation } from '@/hooks/useTranslation';

/** A text field of the provider forms. */
export const INPUT = FIELD_INPUT;
export const CARD = 'rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-4';
export const LABEL = 'mb-1 block text-xs font-medium text-[var(--text-primary)]';
export const CODE = 'rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-primary)]';

/** "Active" or "Not configured" chip. */
function ProviderStatus({ config }: { config: SsoProviderConfig | undefined }) {
    return (
        <span className={config?.enabled ? CHIP_SUCCESS : CHIP}>
            <span className={config?.enabled ? DOT_LIVE : DOT_OFF} aria-hidden="true" />
            {config?.enabled ? 'Active' : 'Not configured'}
        </span>
    );
}

interface ProviderHeaderProps {
    logo: ReactNode;
    title: string;
    description: string;
    config: SsoProviderConfig;
}

/** Logo (brand colours), name, one-line description and status of a provider pane. */
export function ProviderHeader({ logo, title, description, config }: ProviderHeaderProps) {
    return (
        <div className="mb-4 flex flex-wrap items-start gap-3">
            <div aria-hidden="true" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--bg-tertiary)] [&>svg]:h-6 [&>svg]:w-6">
                {logo}
            </div>
            <div className="min-w-[12rem] flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <h3 className="m-0 text-base font-semibold text-[var(--text-primary)]">{title}</h3>
                    <ProviderStatus config={config} />
                </div>
                <p className="m-0 mt-1 text-xs text-[var(--text-secondary)]">{description}</p>
            </div>
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
                className={`${INPUT} font-mono`}
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
                {t('admin.sso_client_secret')} {providers[provider].clientSecretSet && <span className="text-xs font-normal text-[var(--success-ink)]">{t('admin.sso_secret_configured')}</span>}
            </label>
            <input
                type="password"
                value={secrets[provider]}
                onChange={(e) => setSecrets(prev => ({ ...prev, [provider]: e.target.value }))}
                placeholder={providers[provider].clientSecretSet ? t('admin.sso_secret_empty') : SECRET_PLACEHOLDER[provider]}
                className={`${INPUT} font-mono`}
            />
        </div>
    );
}

/** The numbered setup steps for one provider. */
export function SetupInstructions({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    return (
        <div className={CARD}>
            <h4 className="m-0 mb-2 text-[13px] font-semibold text-[var(--text-primary)]">{t('admin_security.sso_setup_title', '📋 Setup Instructions')}</h4>
            <ol className="m-0 list-inside list-decimal space-y-1.5 p-0 text-xs text-[var(--text-secondary)]">
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
        <div className="flex gap-2">
            <button type="button" onClick={() => handleSaveProvider(provider)} disabled={saving[provider]} className={PRIMARY_BTN}>
                {saving[provider] ? t('admin.sso_saving') : t('admin.sso_save')}
            </button>
            <button type="button" onClick={() => handleTestProvider(provider)} disabled={testing[provider] || !canTest} className={SECONDARY_BTN}>
                {testing[provider] ? t('admin.sso_testing') : testLabel}
            </button>
        </div>
    );
}
