import { Fragment } from 'react';
import {
    CARD, CODE, INPUT_STYLE, LABEL,
    ClientIdField, ClientSecretField, ProviderActions, ProviderHeader, SetupInstructions,
} from './SsoFormParts';
import type { SsoProvidersState } from './useSsoProviders';
import { useTranslation } from '../../../../hooks/useTranslation';

const TENANT_ALIASES = ['common', 'organizations', 'consumers'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A tenant id is a directory GUID or one of the known aliases; empty defaults to common. */
export function isTenantIdValid(tid: string): boolean {
    if (!tid) return true; // empty defaults to common
    if (TENANT_ALIASES.includes(tid.toLowerCase().trim())) return true;
    return GUID.test(tid.trim());
}

/** Empty or an alias: any tenant may sign in. */
export function isMultiTenantId(tid: string): boolean {
    return !tid || TENANT_ALIASES.includes(tid.toLowerCase().trim());
}

function TenantIdField({ sso }: { sso: SsoProvidersState }) {
    const { t } = useTranslation();
    const { providers, updateProviderField } = sso;
    const tenantId = providers.microsoft.tenantId || '';
    const tenantIdValid = isTenantIdValid(tenantId);
    const isMultiTenant = isMultiTenantId(tenantId);
    return (
        <div className="lg:col-span-2">
            <label className={LABEL}>
                {t('admin_security.sso_tenant_id', 'Tenant ID')}
                {isMultiTenant ? (
                    <span className="text-blue-400 text-xs ml-2">{t('admin_security.sso_multi_tenant', '(multi-tenant)')}</span>
                ) : tenantIdValid ? (
                    <span className="text-green-400 text-xs ml-2">{t('admin_security.sso_single_tenant', '(single-tenant)')}</span>
                ) : (
                    <span className="text-orange-400 text-xs ml-2">{t('admin_security.sso_tenant_invalid', '(invalid format: should be a GUID or "common")')}</span>
                )}
            </label>
            <input
                type="text"
                value={providers.microsoft.tenantId}
                onChange={(e) => updateProviderField('microsoft', 'tenantId', e.target.value)}
                placeholder={t('admin_security.sso_tenant_ph', 'common')}
                className="w-full px-4 py-2.5 rounded-lg text-sm font-mono"
                style={{
                    ...INPUT_STYLE,
                    border: `1px solid ${!tenantIdValid ? 'rgba(251, 146, 60, 0.5)' : 'var(--border-default)'}`,
                }}
            />
            <div className="mt-2 p-3 rounded-lg text-xs [background:var(--bg-tertiary)] [border:1px_solid_var(--border-default)]">
                <p className="text-secondary mb-1"><strong>{t('admin_security.sso_single_app', 'Single-tenant app')}</strong> {t('admin_security.sso_single_app_desc', 'paste your Directory (tenant) ID from Azure Portal → App Overview (e.g.')} <code className="text-muted">xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code>{t('admin_security.sso_single_app_desc2', '). Required if "Supported account types" is set to "Single tenant".')}</p>
                <p className="text-secondary"><strong>{t('admin_security.sso_multi_app', 'Multi-tenant app')}</strong> {t('admin_security.sso_multi_app_use', 'use')} <code className="text-muted">common</code> {t('admin_security.sso_multi_app_any', '(any Microsoft account),')} <code className="text-muted">organizations</code> {t('admin_security.sso_multi_app_work', '(work/school only), or')} <code className="text-muted">consumers</code> {t('admin_security.sso_multi_app_personal', '(personal only).')}</p>
            </div>
        </div>
    );
}

const GRAPH_SCOPES = ['Mail.Read', 'Mail.Send', 'Calendars.ReadWrite', 'Files.ReadWrite', 'Contacts.ReadWrite', 'offline_access'];

function MicrosoftSetupSteps({ redirectBase }: { redirectBase: string }) {
    const { t } = useTranslation();
    return (
        <SetupInstructions>
            <li>{t('admin_security.sso_go_to', 'Go to')} <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">{t('admin_security.sso_ms_portal', 'Azure Portal → App registrations')}</a></li>
            <li>{t('admin_security.sso_ms_step2', 'Register a new application or select an existing one')}</li>
            <li>{t('admin_security.sso_ms_step3', 'Add a redirect URI (Web):')} <code className={CODE}>{redirectBase}/auth/callback/microsoft</code></li>
            <li>{t('admin_security.sso_ms_step4', 'Create a client secret under "Certificates & secrets"')}</li>
            <li>{t('admin_security.sso_ms_step5', 'Copy the Application (Client) ID and Secret Value here')}</li>
            <li>{t('admin_security.sso_ms_step6_for', 'For')} <strong>{t('admin_security.sso_ms_step6_apps', 'single-tenant apps')}</strong>{t('admin_security.sso_ms_step6_rest', ': copy the Directory (tenant) ID from the app Overview page and paste it in the Tenant ID field above')}</li>
            <li>{t('admin_security.sso_ms_step7_a', 'Under "API permissions", add the following')} <strong>{t('admin_security.sso_ms_graph', 'Microsoft Graph')}</strong> {t('admin_security.sso_ms_step7_b', 'delegated permissions and grant admin consent:')} {GRAPH_SCOPES.map((scope, i) => (
                <Fragment key={scope}>{i > 0 && ', '}<code className={CODE}>{scope}</code></Fragment>
            ))}</li>
        </SetupInstructions>
    );
}

export default function MicrosoftSsoTab({ sso }: { sso: SsoProvidersState }) {
    const { t } = useTranslation();
    const { providers, redirectBase } = sso;
    return (
        <div className="space-y-6">
            <div className={CARD}>
                <ProviderHeader
                    logoBackground="rgba(0, 164, 239, 0.15)"
                    logo={(
                        <svg className="w-7 h-7" viewBox="0 0 23 23">
                            <path fill="#f35325" d="M1 1h10v10H1z" />
                            <path fill="#81bc06" d="M12 1h10v10H12z" />
                            <path fill="#05a6f0" d="M1 12h10v10H1z" />
                            <path fill="#ffba08" d="M12 12h10v10H12z" />
                        </svg>
                    )}
                    title={t('admin_security.sso_ms_title', 'Microsoft / Azure AD')}
                    description={t('admin_security.sso_ms_desc', 'Allow users to sign in with Microsoft accounts')}
                    config={providers.microsoft}
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <ClientIdField
                        provider="microsoft"
                        sso={sso}
                        label={t('admin_security.sso_ms_application', 'Application ({label})', { label: t('admin.sso_client_id') })}
                        placeholder={t('admin_security.sso_ms_client_id_ph', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                    />
                    <ClientSecretField provider="microsoft" sso={sso} />
                    <TenantIdField sso={sso} />
                </div>
            </div>

            <MicrosoftSetupSteps redirectBase={redirectBase} />

            <ProviderActions provider="microsoft" sso={sso} canTest={!!providers.microsoft.clientId} testLabel={t('admin.sso_validate')} />
        </div>
    );
}
