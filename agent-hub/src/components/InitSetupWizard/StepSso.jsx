import React from 'react';
import { MicrosoftLogo } from './ProviderLogos';
import { useTranslation } from '../../hooks/useTranslation';

const StepSso = ({ isAzure, msClientId, setMsClientId, msClientSecret, setMsClientSecret, msTenantId, setMsTenantId, inputClass, inputStyle }) => {
    const { t } = useTranslation();
    return (
    <>
        <div className="flex items-center gap-3 mb-3">
            <MicrosoftLogo size={28} />
            <div>
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                    {isAzure ? 'Azure AD / Entra ID SSO' : 'Microsoft SSO'}
                </span>
                <span className="text-xs px-2 py-0.5 ml-2 rounded-full" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--accent-primary)' }}>{t('init_setup.step_sso_optional', 'Optional')}</span>
            </div>
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
            {t('init_setup.step_sso_enable_sign_in_with_microsoft_for_your', 'Enable "Sign in with Microsoft" for your users. Register an app in')}{' '}
            <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
                target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>
                {t('init_setup.step_sso_azure_portal_app_registrations', 'Azure Portal → App Registrations')}
            </a>.
        </p>
        <div className="space-y-3">
            <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('init_setup.step_sso_application_client_id', 'Application (Client) ID')}</label>
                <input type="text" value={msClientId} onChange={e => setMsClientId(e.target.value)}
                    placeholder={t('init_setup.step_sso_xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('init_setup.step_sso_client_secret', 'Client Secret')}</label>
                <input type="password" value={msClientSecret} onChange={e => setMsClientSecret(e.target.value)}
                    placeholder={t('init_setup.step_sso_client_secret_value', 'Client secret value')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                <label className="block text-xs font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>{t('init_setup.step_sso_tenant_id', 'Tenant ID')}</label>
                <input type="text" value={msTenantId} onChange={e => setMsTenantId(e.target.value)}
                    placeholder={t('init_setup.step_sso_common_multi_tenant_or_your_tenant', 'common (multi-tenant) or your tenant GUID')}
                    className={inputClass} style={inputStyle} />
                <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                    {t('init_setup.step_sso_use', 'Use')} <code className="px-1 py-0.5 rounded text-xs" style={{ background: 'var(--bg-tertiary)' }}>common</code> {t('init_setup.step_sso_for_multi_tenant_or_your_specific', 'for multi-tenant, or your specific Azure AD tenant ID.')}
                </p>
            </div>
        </div>
    </>
);
};

export default StepSso;
