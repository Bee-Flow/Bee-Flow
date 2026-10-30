import { Fragment, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { Plus, Trash2, Upload, X } from 'lucide-react';
import {
    CARD, CODE, LABEL,
    ClientIdField, ClientSecretField, ProviderActions, ProviderHeader, SetupInstructions,
} from './SsoFormParts';
import { newConnectionId } from './useSsoProviders';
import type { MicrosoftConnection, SsoProvidersState } from './useSsoProviders';
import { useTranslation } from '@/hooks/useTranslation';

const TENANT_ALIASES = ['common', 'organizations', 'consumers'];
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INPUT = 'w-full px-4 py-2.5 rounded-lg text-sm bg-[var(--bg-tertiary)] border text-[var(--text-primary)]';
const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp', 'image/gif'];
/** The same ceiling as the server (auth/oauth/microsoftConnections.mts). */
export const MAX_LOGO_BYTES = 100 * 1024;

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

/** Why a chosen file cannot be a button logo, or null when it can. */
export function logoFileProblem(file: { type: string; size: number }): 'type' | 'size' | null {
    if (!LOGO_TYPES.includes(file.type)) return 'type';
    if (file.size > MAX_LOGO_BYTES) return 'size';
    return null;
}

const MicrosoftLogo = () => (
    <svg className="w-5 h-5" viewBox="0 0 23 23" aria-hidden="true">
        <path fill="#f35325" d="M1 1h10v10H1z" />
        <path fill="#81bc06" d="M12 1h10v10H12z" />
        <path fill="#05a6f0" d="M1 12h10v10H1z" />
        <path fill="#ffba08" d="M12 12h10v10H12z" />
    </svg>
);

interface TenantIdFieldProps {
    value: string;
    onChange: (value: string) => void;
    /** The long explanation; shown once, on the primary app. */
    withHelp?: boolean;
    id?: string;
}

function TenantIdField({ value, onChange, withHelp, id }: TenantIdFieldProps) {
    const { t } = useTranslation();
    const tenantId = value || '';
    const tenantIdValid = isTenantIdValid(tenantId);
    const isMultiTenant = isMultiTenantId(tenantId);
    return (
        <div className="lg:col-span-2">
            <label htmlFor={id} className={LABEL}>
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
                id={id}
                type="text"
                value={tenantId}
                onChange={(e) => onChange(e.target.value)}
                placeholder={t('admin_security.sso_tenant_ph', 'common')}
                className={`${INPUT} font-mono ${tenantIdValid ? 'border-[var(--border-default)]' : 'border-orange-400/50'}`}
            />
            {withHelp && (
                <div className="mt-2 p-3 rounded-lg text-xs bg-[var(--bg-tertiary)] border border-[var(--border-default)]">
                    <p className="text-secondary mb-1"><strong>{t('admin_security.sso_single_app', 'Single-tenant app')}</strong> {t('admin_security.sso_single_app_desc', 'paste your Directory (tenant) ID from Azure Portal → App Overview (e.g.')} <code className="text-muted">xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx</code>{t('admin_security.sso_single_app_desc2', '). Required if "Supported account types" is set to "Single tenant".')}</p>
                    <p className="text-secondary"><strong>{t('admin_security.sso_multi_app', 'Multi-tenant app')}</strong> {t('admin_security.sso_multi_app_use', 'use')} <code className="text-muted">common</code> {t('admin_security.sso_multi_app_any', '(any Microsoft account),')} <code className="text-muted">organizations</code> {t('admin_security.sso_multi_app_work', '(work/school only), or')} <code className="text-muted">consumers</code> {t('admin_security.sso_multi_app_personal', '(personal only).')}</p>
                </div>
            )}
        </div>
    );
}

interface LogoFieldProps {
    value: string;
    onChange: (dataUrl: string) => void;
    inputId: string;
}

/** Pick a small image for the login button; it travels as a data URL inside the configuration. */
function LogoField({ value, onChange, inputId }: LogoFieldProps) {
    const { t } = useTranslation();
    const [problem, setProblem] = useState<'type' | 'size' | null>(null);
    const fileRef = useRef<HTMLInputElement>(null);
    const onFile = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (!file) return;
        const why = logoFileProblem(file);
        setProblem(why);
        if (why) return;
        const reader = new FileReader();
        reader.onload = () => { if (typeof reader.result === 'string') onChange(reader.result); };
        reader.readAsDataURL(file);
    };
    return (
        <div>
            <span className={LABEL}>{t('admin_security.sso_ms_logo', 'Logo')}</span>
            <div className="flex items-center gap-3">
                <div className="h-10 min-w-10 max-w-[160px] px-2 rounded-lg border border-[var(--border-default)] bg-white flex items-center justify-center overflow-hidden">
                    {value ? <img src={value} alt="" className="h-7 w-auto max-w-[140px] object-contain" /> : <MicrosoftLogo />}
                </div>
                <input ref={fileRef} id={inputId} type="file" accept={LOGO_TYPES.join(',')} onChange={onFile} className="sr-only" />
                <button type="button" onClick={() => fileRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border border-[var(--border-default)] text-[var(--text-secondary)] bg-[var(--bg-secondary)]">
                    <Upload className="w-4 h-4" /> {t('admin_security.sso_ms_logo_choose', 'Choose image')}
                </button>
                {value && (
                    <button type="button" onClick={() => { onChange(''); setProblem(null); }}
                        className="inline-flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)]">
                        <X className="w-3.5 h-3.5" /> {t('admin_security.sso_ms_logo_remove', 'Remove logo')}
                    </button>
                )}
            </div>
            <p className={`mt-1.5 text-xs ${problem ? 'text-orange-400' : 'text-muted'}`}>
                {problem === 'size' ? t('admin_security.sso_ms_logo_too_large', 'That image is larger than 100 KB.')
                    : problem === 'type' ? t('admin_security.sso_ms_logo_type', 'Choose a PNG, JPEG, SVG or WebP image.')
                        : t('admin_security.sso_ms_logo_hint', 'PNG, JPEG, SVG or WebP, at most 100 KB.')}
            </p>
        </div>
    );
}

interface ButtonFieldsProps {
    label: string;
    logo: string;
    onLabel: (value: string) => void;
    onLogo: (value: string) => void;
    idPrefix: string;
}

/** The login button's text and logo, with a preview of the button as the login page shows it. */
function LoginButtonFields({ label, logo, onLabel, onLogo, idPrefix }: ButtonFieldsProps) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div>
                <label htmlFor={`${idPrefix}-label`} className={LABEL}>{t('admin_security.sso_ms_button_label', 'Button text')}</label>
                <input id={`${idPrefix}-label`} type="text" value={label} maxLength={60}
                    onChange={(e) => onLabel(e.target.value)}
                    placeholder={t('admin_security.sso_ms_button_label_ph', 'Sign in with Microsoft')}
                    className={`${INPUT} border-[var(--border-default)]`} />
            </div>
            <LogoField value={logo} onChange={onLogo} inputId={`${idPrefix}-logo`} />
            <div className="lg:col-span-2">
                <span className={LABEL}>{t('admin_security.sso_ms_preview', 'Preview')}</span>
                <div className="max-w-sm py-2.5 px-4 bg-white text-gray-700 border border-gray-200 rounded-xl font-medium flex items-center justify-center gap-2.5 shadow-sm" aria-hidden="true">
                    {logo ? <img src={logo} alt="" className="h-7 w-auto max-w-[120px] object-contain" /> : <MicrosoftLogo />}
                    {label || t('admin_security.sso_ms_button_label_ph', 'Sign in with Microsoft')}
                </div>
            </div>
        </div>
    );
}

interface ConnectionCardProps {
    index: number;
    connection: MicrosoftConnection;
    secret: string;
    onChange: (next: MicrosoftConnection) => void;
    onSecret: (secret: string) => void;
    onRemove: () => void;
}

function ConnectionCard({ index, connection, secret, onChange, onSecret, onRemove }: ConnectionCardProps) {
    const { t } = useTranslation();
    const idPrefix = `ms-connection-${connection.id}`;
    const set = (patch: Partial<MicrosoftConnection>) => onChange({ ...connection, ...patch });
    return (
        <div className="p-5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-primary)] space-y-5" data-testid={`ms-connection-${index}`}>
            <div className="flex items-center justify-between">
                <h4 className="font-semibold text-primary">{t('admin_security.sso_ms_connection_n', 'Tenant {n}', { n: index + 1 })}</h4>
                <button type="button" onClick={onRemove}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-red-400">
                    <Trash2 className="w-3.5 h-3.5" /> {t('admin_security.sso_ms_connection_remove', 'Remove')}
                </button>
            </div>
            <LoginButtonFields label={connection.label} logo={connection.logo} idPrefix={idPrefix}
                onLabel={(label) => set({ label })} onLogo={(logo) => set({ logo })} />
            <p className="text-xs text-muted -mt-3">{t('admin_security.sso_ms_connection_label_hint', 'Shown on the button, for example the name of the subsidiary.')}</p>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                    <label htmlFor={`${idPrefix}-client`} className={LABEL}>{t('admin_security.sso_ms_application', 'Application ({label})', { label: t('admin.sso_client_id') })}</label>
                    <input id={`${idPrefix}-client`} type="text" value={connection.clientId}
                        onChange={(e) => set({ clientId: e.target.value })}
                        placeholder={t('admin_security.sso_ms_client_id_ph', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                        className={`${INPUT} font-mono border-[var(--border-default)]`} />
                </div>
                <div>
                    <label htmlFor={`${idPrefix}-secret`} className={LABEL}>
                        {t('admin.sso_client_secret')} {connection.clientSecretSet && <span className="text-green-400 text-xs">{t('admin.sso_secret_configured')}</span>}
                    </label>
                    <input id={`${idPrefix}-secret`} type="password" value={secret}
                        onChange={(e) => onSecret(e.target.value)}
                        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- the placeholder text of the empty secret field, not a secret
                        placeholder={connection.clientSecretSet ? t('admin.sso_secret_empty') : t('admin_security.sso_ms_secret_ph', 'Client Secret Value')}
                        className={`${INPUT} font-mono border-[var(--border-default)]`} />
                </div>
                <TenantIdField id={`${idPrefix}-tenant`} value={connection.tenantId} onChange={(tenantId) => set({ tenantId })} />
            </div>
        </div>
    );
}

/** The additional tenants: each its own app registration and its own login button. */
function ConnectionsCard({ sso }: { sso: SsoProvidersState }) {
    const { t } = useTranslation();
    const { providers, connectionSecrets, setConnectionSecret, setConnections } = sso;
    const connections = providers.microsoft.connections ?? [];
    const replace = (index: number, next: MicrosoftConnection) => setConnections(connections.map((c, i) => (i === index ? next : c)));
    const add = () => setConnections([...connections, { id: newConnectionId(), label: '', logo: '', clientId: '', tenantId: '', clientSecretSet: false }]);
    return (
        <div className={CARD}>
            <h4 className="font-semibold text-primary mb-1">{t('admin_security.sso_ms_connections_title', 'Additional Microsoft tenants')}</h4>
            <p className="text-sm text-muted mb-5">{t('admin_security.sso_ms_connections_desc', 'Each additional tenant has its own app registration and its own button on the login page. Register the same redirect URI in every app.')}</p>
            <div className="space-y-4">
                {connections.length === 0 && (
                    <p className="text-sm text-secondary">{t('admin_security.sso_ms_connections_empty', 'No additional tenants. Everyone signs in through the app registration above.')}</p>
                )}
                {connections.map((connection, index) => (
                    <ConnectionCard key={connection.id} index={index} connection={connection}
                        secret={connectionSecrets[connection.id] || ''}
                        onChange={(next) => replace(index, next)}
                        onSecret={(secret) => setConnectionSecret(connection.id, secret)}
                        onRemove={() => setConnections(connections.filter((_, i) => i !== index))} />
                ))}
            </div>
            <button type="button" onClick={add} data-testid="ms-connection-add"
                className="mt-5 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border border-[var(--border-default)] text-[var(--text-secondary)] bg-[var(--bg-primary)] hover:text-[var(--text-primary)]">
                <Plus className="w-4 h-4" /> {t('admin_security.sso_ms_connection_add', 'Add tenant')}
            </button>
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
    const { providers, redirectBase, updateProviderField } = sso;
    const ms = providers.microsoft;
    return (
        <div className="space-y-6">
            <div className={CARD}>
                <ProviderHeader
                    logoBackground="rgba(0, 164, 239, 0.15)"
                    logo={<svg className="w-7 h-7" viewBox="0 0 23 23"><path fill="#f35325" d="M1 1h10v10H1z" /><path fill="#81bc06" d="M12 1h10v10H12z" /><path fill="#05a6f0" d="M1 12h10v10H1z" /><path fill="#ffba08" d="M12 12h10v10H12z" /></svg>}
                    title={t('admin_security.sso_ms_title', 'Microsoft / Azure AD')}
                    description={t('admin_security.sso_ms_desc', 'Allow users to sign in with Microsoft accounts')}
                    config={ms}
                />

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                    <ClientIdField
                        provider="microsoft"
                        sso={sso}
                        label={t('admin_security.sso_ms_application', 'Application ({label})', { label: t('admin.sso_client_id') })}
                        placeholder={t('admin_security.sso_ms_client_id_ph', 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx')}
                    />
                    <ClientSecretField provider="microsoft" sso={sso} />
                    <TenantIdField id="ms-tenant" value={ms.tenantId || ''} onChange={(v) => updateProviderField('microsoft', 'tenantId', v)} withHelp />
                </div>
            </div>

            <div className={CARD}>
                <h4 className="font-semibold text-primary mb-1">{t('admin_security.sso_ms_button_title', 'Login button')}</h4>
                <p className="text-sm text-muted mb-5">{t('admin_security.sso_ms_button_desc', 'What this app\'s button on the login page shows. Leave the text empty for "Sign in with Microsoft"; without a logo the Microsoft logo is used.')}</p>
                <LoginButtonFields label={ms.label || ''} logo={ms.logo || ''} idPrefix="ms-primary"
                    onLabel={(v) => updateProviderField('microsoft', 'label', v)}
                    onLogo={(v) => updateProviderField('microsoft', 'logo', v)} />
            </div>

            <ConnectionsCard sso={sso} />

            <MicrosoftSetupSteps redirectBase={redirectBase} />

            <ProviderActions provider="microsoft" sso={sso} canTest={!!ms.clientId} testLabel={t('admin.sso_validate')} />
        </div>
    );
}
