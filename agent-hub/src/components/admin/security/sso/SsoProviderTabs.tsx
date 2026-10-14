import {
    CARD, CODE, INPUT_STYLE, LABEL,
    ClientIdField, ClientSecretField, ProviderActions, ProviderHeader, SetupInstructions,
} from './SsoFormParts';
import type { SsoProvidersState } from './useSsoProviders';
import { useTranslation } from '../../../../hooks/useTranslation';

interface TabProps {
    sso: SsoProvidersState;
}

export function NextcloudSsoTab({ sso }: TabProps) {
    const { t } = useTranslation();
    const { providers, updateProviderField, redirectBase } = sso;
    return (
        <div className="space-y-6">
            <div className={CARD}>
                <ProviderHeader
                    logoBackground="rgba(0, 130, 201, 0.15)"
                    logo={(
                        <svg className="w-7 h-7" style={{ color: '#0082c9' }} fill="currentColor" viewBox="0 0 24 24">
                            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" />
                        </svg>
                    )}
                    title={t('admin_security.sso_nc_title', 'Nextcloud OAuth 2.0')}
                    description={t('admin_security.sso_nc_desc', 'Allow users to sign in with their Nextcloud account')}
                    config={providers.nextcloud}
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <div className="lg:col-span-2">
                        <label className={LABEL}>{t('admin_security.sso_nc_url', 'Nextcloud URL')}</label>
                        <input
                            type="url"
                            value={providers.nextcloud.url}
                            onChange={(e) => updateProviderField('nextcloud', 'url', e.target.value)}
                            placeholder="https://your-nextcloud.com"
                            className="w-full px-4 py-2.5 rounded-lg text-sm"
                            style={INPUT_STYLE}
                        />
                    </div>
                    <ClientIdField provider="nextcloud" sso={sso} label={t('admin.sso_client_id')} placeholder={t('admin_security.sso_nc_client_id_ph', 'OAuth Client ID')} />
                    <ClientSecretField provider="nextcloud" sso={sso} />
                </div>
            </div>

            <SetupInstructions>
                <li>{t('admin_security.sso_nc_step1', 'Go to Nextcloud → Settings → Security → OAuth 2.0 clients')}</li>
                <li>{t('admin_security.sso_nc_step2', 'Click "Add client" and enter a name (e.g., "Bee Flow")')}</li>
                <li>{t('admin_security.sso_nc_step3', 'Set the redirect URL to:')} <code className={CODE}>{redirectBase}/auth/callback/nextcloud</code></li>
                <li>{t('admin_security.sso_copy_client', 'Copy the Client ID and Client Secret here')}</li>
            </SetupInstructions>

            <ProviderActions provider="nextcloud" sso={sso} canTest={!!providers.nextcloud.url} testLabel={t('admin.sso_test')} />
        </div>
    );
}

export function GoogleSsoTab({ sso }: TabProps) {
    const { t } = useTranslation();
    const { providers, redirectBase } = sso;
    return (
        <div className="space-y-6">
            <div className={CARD}>
                <ProviderHeader
                    logoBackground="rgba(66, 133, 244, 0.15)"
                    logo={(
                        <svg className="w-7 h-7" viewBox="0 0 24 24">
                            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                        </svg>
                    )}
                    title={t('admin_security.sso_g_title', 'Google OAuth 2.0')}
                    description={t('admin_security.sso_g_desc', 'Allow users to sign in with their Google account')}
                    config={providers.google}
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <ClientIdField provider="google" sso={sso} label={t('admin.sso_client_id')} placeholder="xxxxxxxxxxxx.apps.googleusercontent.com" />
                    <ClientSecretField provider="google" sso={sso} />
                </div>
            </div>

            <SetupInstructions>
                <li>{t('admin_security.sso_go_to', 'Go to')} <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{t('admin_security.sso_g_console', 'Google Cloud Console → Credentials')}</a></li>
                <li>{t('admin_security.sso_g_step2', 'Create a new OAuth 2.0 Client ID (Web application)')}</li>
                <li>{t('admin_security.sso_g_step3', 'Add authorized redirect URI:')} <code className={CODE}>{redirectBase}/auth/callback/google</code></li>
                <li>{t('admin_security.sso_copy_client', 'Copy the Client ID and Client Secret here')}</li>
            </SetupInstructions>

            <ProviderActions provider="google" sso={sso} canTest={!!providers.google.clientId} testLabel={t('admin.sso_validate')} />
        </div>
    );
}
