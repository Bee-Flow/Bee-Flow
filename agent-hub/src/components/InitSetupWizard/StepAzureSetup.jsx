import React, { useState } from 'react';
import { AzureOpenAILogo, BingLogo, MicrosoftLogo } from './ProviderLogos';
import { useTranslation } from '../../hooks/useTranslation';

const Section = ({ Logo, title, subtitle, children, defaultOpen = true }) => {
    const [open, setOpen] = useState(defaultOpen);
    return (
        <div className="rounded-xl border-2 overflow-hidden transition-all" style={{ borderColor: '#e5e7eb', background: '#fff' }}>
            <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-3 p-4 text-left hover:bg-gray-50/50 transition-colors">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'rgba(0,120,212,0.08)' }}>
                    <Logo size={20} />
                </div>
                <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold" style={{ color: '#1f2937' }}>{title}</div>
                    <div className="text-xs" style={{ color: '#6b7280' }}>{subtitle}</div>
                </div>
                <svg className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} style={{ color: '#9ca3af' }} viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
            </button>
            {open && <div className="px-4 pb-4 space-y-3 border-t" style={{ borderColor: '#f3f4f6' }}>{children}</div>}
        </div>
    );
};

const Label = ({ children }) => (
    <label className="block text-xs font-medium mb-1" style={{ color: '#374151' }}>{children}</label>
);

const StepAzureSetup = ({
    azureEndpoint, setAzureEndpoint,
    azureKey, setAzureKey,
    azureModels, setAzureModels,
    bingKey, setBingKey,
    bingMarket, setBingMarket,
    msClientId, setMsClientId,
    msClientSecret, setMsClientSecret,
    msTenantId, setMsTenantId,
    officeAppsEnabled, setOfficeAppsEnabled,
    inputClass, inputStyle,
}) => {
    const { t } = useTranslation();
    return (
    <div className="space-y-3">
        {/* Microsoft Entra ID SSO — first */}
        <Section Logo={MicrosoftLogo} title={t('init_setup.step_azure_setup_microsoft_entra_id', 'Microsoft Entra ID')} subtitle="Enable 'Sign in with Microsoft' for your users">
            <div>
                <Label>{t('init_setup.step_azure_setup_application_client_id', 'Application (Client) ID')}</Label>
                <input type="text" value={msClientId} onChange={e => setMsClientId(e.target.value)}
                    placeholder={t('init_setup.step_azure_setup_xxxxxxxx_xxxx_xxxx_xxxx_xxxxxxxxxxxx', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */}
                <Label>{t('init_setup.step_azure_setup_client_secret', 'Client Secret')}</Label>
                <input type="password" value={msClientSecret} onChange={e => setMsClientSecret(e.target.value)}
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */
                    placeholder={t('init_setup.step_azure_setup_client_secret_value', 'Client secret value')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                <Label>{t('init_setup.step_azure_setup_tenant_id', 'Tenant ID')}</Label>
                <input type="text" value={msTenantId} onChange={e => setMsTenantId(e.target.value)}
                    placeholder={t('init_setup.step_azure_setup_common_or_your_tenant_guid', 'common or your tenant GUID')}
                    className={inputClass} style={inputStyle} />
                <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>
                    <code className="px-1 py-0.5 rounded text-xs" style={{ background: '#f3f4f6' }}>common</code> {t('init_setup.step_azure_setup_multi_tenant', '= multi-tenant')}
                </p>
            </div>
            <p className="text-xs" style={{ color: '#9ca3af' }}>
                {t('init_setup.step_azure_setup_register_at', 'Register at')}{' '}
                <a href="https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer"
                    className="underline" style={{ color: '#0078D4' }}>{t('init_setup.step_azure_setup_azure_portal_app_registrations', 'Azure Portal → App Registrations')}</a>
            </p>
        </Section>

        {/* Azure OpenAI — second */}
        <Section Logo={AzureOpenAILogo} title={t('init_setup.step_azure_setup_azure_openai', 'Azure OpenAI')} subtitle="AI model endpoint and deployment configuration" defaultOpen={false}>
            <div>
                <Label>{t('init_setup.step_azure_setup_endpoint_url', 'Endpoint URL')}</Label>
                <input type="text" value={azureEndpoint} onChange={e => setAzureEndpoint(e.target.value)}
                    placeholder="https://your-resource.openai.azure.com"
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                <Label>{t('init_setup.step_azure_setup_api_key', 'API Key')}</Label>
                <input type="password" value={azureKey} onChange={e => setAzureKey(e.target.value)}
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */
                    placeholder={t('init_setup.step_azure_setup_your_azure_api_key', 'Your Azure API key')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                <Label>{t('init_setup.step_azure_setup_deployment_names', 'Deployment Names')}</Label>
                <input type="text" value={azureModels} onChange={e => setAzureModels(e.target.value)}
                    placeholder={t('init_setup.step_azure_setup_gpt_5_6_terra_gpt_6_astra_gpt_4_1', 'gpt-5.6-terra, gpt-6-astra, gpt-4.1')}
                    className={inputClass} style={inputStyle} />
                <p className="text-xs mt-1" style={{ color: '#9ca3af' }}>{t('init_setup.step_azure_setup_comma_separated_names_from_your_azure', 'Comma-separated names from your Azure portal. Use name=model when a deployment is not named after its model (e.g. prod-chat=gpt-6-astra).')}</p>
            </div>
        </Section>

        {/* Bing Search — third */}
        <Section Logo={BingLogo} title={t('init_setup.step_azure_setup_bing_web_search', 'Bing Web Search')} subtitle="Enable web search powered by Azure Bing" defaultOpen={false}>
            <div>
                <Label>{t('init_setup.step_azure_setup_bing_api_subscription_key', 'Bing API Subscription Key')}</Label>
                <input type="password" value={bingKey} onChange={e => setBingKey(e.target.value)}
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */
                    placeholder={t('init_setup.step_azure_setup_your_bing_search_api_key', 'Your Bing Search API key')}
                    className={inputClass} style={inputStyle} />
            </div>
            <div>
                <Label>{t('init_setup.step_azure_setup_market_optional', 'Market (optional)')}</Label>
                <input type="text" value={bingMarket} onChange={e => setBingMarket(e.target.value)}
                    placeholder={t('init_setup.step_azure_setup_e_g_nl_nl_en_us', 'e.g. nl-NL, en-US')}
                    className={inputClass} style={inputStyle} />
            </div>
            <p className="text-xs" style={{ color: '#9ca3af' }}>
                {t('init_setup.step_azure_setup_get_your_key_from', 'Get your key from')}{' '}
                <a href="https://portal.azure.com/#create/microsoft.bingsearch" target="_blank" rel="noopener noreferrer"
                    className="underline" style={{ color: '#0078D4' }}>{t('init_setup.step_azure_setup_azure_portal_bing_search', 'Azure Portal → Bing Search')}</a>
            </p>
        </Section>

        {/* Office Application Integration — fourth */}
        <Section Logo={MicrosoftLogo} title={t('init_setup.step_azure_setup_office_application_integration', 'Office Application Integration')} subtitle="Outlook, OneDrive, and Calendar tools for users" defaultOpen={false}>
            <div className="flex items-center justify-between py-1">
                <div>
                    <div className="text-sm font-medium" style={{ color: '#374151' }}>{t('init_setup.step_azure_setup_enable_office_365_tools', 'Enable Office 365 tools')}</div>
                    <p className="text-xs mt-0.5" style={{ color: '#9ca3af' }}>
                        {t('init_setup.step_azure_setup_let_users_access_outlook_mail_onedrive', 'Let users access Outlook mail, OneDrive files, and Calendar via Microsoft Graph')}
                    </p>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={officeAppsEnabled}
                    onClick={() => setOfficeAppsEnabled(!officeAppsEnabled)}
                    className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-offset-2"
                    style={{
                        background: officeAppsEnabled ? '#0078D4' : '#d1d5db',
                        focusRingColor: '#0078D4',
                    }}
                >
                    <span
                        className="pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg ring-0 transition-transform duration-200 ease-in-out"
                        style={{ transform: officeAppsEnabled ? 'translateX(1.25rem)' : 'translateX(0)' }}
                    />
                </button>
            </div>
            <p className="text-xs" style={{ color: '#9ca3af' }}>
                {t('init_setup.step_azure_setup_requires_the_entra_id_app_registration', 'Requires the Entra ID app registration above with')}{' '}
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: '#f3f4f6' }}>Mail.Read</code>,{' '}
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: '#f3f4f6' }}>Mail.Send</code>,{' '}
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: '#f3f4f6' }}>Files.ReadWrite</code>{t('init_setup.step_azure_setup_and', ', and')}{' '}
                <code className="px-1 py-0.5 rounded text-xs" style={{ background: '#f3f4f6' }}>Calendars.ReadWrite</code> scopes.
            </p>
        </Section>
    </div>
);
};

export default StepAzureSetup;
