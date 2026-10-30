import React, { useMemo, useState } from 'react';
import ConnectionsManager from './ConnectionsManager';
import { Microsoft365Group } from './Microsoft365Integration';
import FirebirdIntegration from './FirebirdIntegration';
import VplanIntegration from './VplanIntegration';
import ScalewayBillingIntegration from './ScalewayBillingIntegration';
import SimpleApiKeyIntegration from './SimpleApiKeyIntegration';
import { toast } from '../../components/shared/Toast';
import { useEntitlements } from '../../components/licensing/EntitlementsContext';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { API_BASE } from '../../utils/helpers';
import { postForBody } from '../../api/postForBody';
import NcScopeSection from '../../components/integrations/nextcloud/NcScopeSection';
import OrgMcpConnections from './OrgMcpConnections';
import type { McpServerSource } from '../../components/apps/appCatalog';
import type { UserSettingSaveResult } from '../../hooks/useUserSettingSave';
import type { SettingsStatuses, SettingsUser } from './shell/settingsShellTypes';
import type { GroupLabelProps, FirefliesIntegrationProps, YouTrackIntegrationProps, SignRequestIntegrationProps, GammaIntegrationProps, AFASIntegrationProps, NMBRSIntegrationProps, GitHubIntegrationProps, NextcloudIntegrationProps, McpCredential, McpCredentialServer, McpCredentialRowsProps, IntegrationGroupProps, IntegrationsSectionProps } from './IntegrationsSection.types';
import { logger } from '../../utils/logger';
import { mutate, ApiError, request, RefusedError } from '../../api/mutate';
import { IntegrationRow, ApiKeyField, DisconnectButton } from './IntegrationPrimitives';
import { GoogleWorkspaceIntegration, LinkedInIntegration, WithingsIntegration } from './OAuthIntegrations';

const GroupLabel = ({ children }: GroupLabelProps) => (
    <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">
        {children}
    </p>
);
// ── Fireflies ─────────────────────────────────────────────────────────────────
// Single-key integration — all save/disconnect/error logic lives in
// SimpleApiKeyIntegration + useUserSettingSave; this is just declarative config.
const FirefliesIntegration = ({ hasFirefliesKey, onSaved, last }: FirefliesIntegrationProps) => {
    const { t } = useTranslation();
    return (
        <SimpleApiKeyIntegration
            last={last}
            connected={hasFirefliesKey}
            name="Fireflies.ai"
            payloadKey="firefliesApiKey"
            description={t('integ.fireflies_desc')}
            connectedDescription={t('integ.fireflies_connected')}
            placeholder={t('settings.integrations.fireflies_key_placeholder', 'Enter your Fireflies.ai API key')}
            onSaved={onSaved}
            icon={<svg viewBox="22 20 24 24" fill="none" className="w-[18px] h-[18px]"><path d="M30.5749 22H24V28.5267H30.5749V22Z" fill="url(#ffs_g1)" /><path d="M38.3633 29.8789H31.7883V36.4056H38.3633V29.8789Z" fill="url(#ffs_g2)" /><path d="M38.3633 22H31.7883V28.5267H43.9998V27.594C43.9997 26.1104 43.4058 24.6875 42.3489 23.6384C41.2919 22.5894 39.8585 22 38.3638 22H38.3633Z" fill="url(#ffs_g3)" /><path d="M24 29.8789V36.4056C24.0002 37.8892 24.594 39.3121 25.6509 40.3612C26.7079 41.4103 28.1413 41.9996 29.636 41.9996H30.5749V29.8789H24Z" fill="url(#ffs_g4)" /><defs><linearGradient id="ffs_g1" x1="40.08" y1="38.51" x2="12.44" y2="9.47" gradientUnits="userSpaceOnUse"><stop stopColor="#E82A73" /><stop offset="0.54" stopColor="#9B4AB0" /><stop offset="1" stopColor="#3B73FF" /></linearGradient><linearGradient id="ffs_g2" x1="40.18" y1="38.42" x2="12.54" y2="9.38" gradientUnits="userSpaceOnUse"><stop stopColor="#FF3C82" /><stop offset="0.49" stopColor="#B251B2" /><stop offset="1" stopColor="#3B73FF" /></linearGradient><linearGradient id="ffs_g3" x1="44.77" y1="34.05" x2="35.4" y2="0.12" gradientUnits="userSpaceOnUse"><stop stopColor="#E82A73" /><stop offset="0.54" stopColor="#9B4AB0" /><stop offset="1" stopColor="#3B73FF" /></linearGradient><linearGradient id="ffs_g4" x1="35.55" y1="42.82" x2="2.03" y2="32.61" gradientUnits="userSpaceOnUse"><stop stopColor="#E82A73" /><stop offset="0.54" stopColor="#9B4AB0" /><stop offset="1" stopColor="#3B73FF" /></linearGradient></defs></svg>}
            hint={<>{t('settings.integrations.get_key_from', 'Get your key from')} <a href="https://app.fireflies.ai/integrations/custom/fireflies" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">app.fireflies.ai</a></>}
        />
    );
};
// ── YouTrack ──────────────────────────────────────────────────────────────────
const YouTrackIntegration = ({ hasYouTrackConfig, onSaved, last }: YouTrackIntegrationProps) => {
    const { t } = useTranslation();
    const [url, setUrl] = useState('');
    const [token, setToken] = useState('');
    const { saving, disconnecting, error, save, disconnect } = useUserSettingSave(onSaved);
    const clearFields = () => { setUrl(''); setToken(''); };
    const handleSave = () => {
        if (!url.trim() && !token.trim()) return;
        const body: { youtrackUrl?: string; youtrackToken?: string } = {};
        if (url.trim()) body.youtrackUrl = url.replace(/\/+$/, '');
        if (token.trim()) body.youtrackToken = token;
        save(body, { onSuccess: clearFields });
    };
    const handleDisconnect = () => disconnect({ youtrackUrl: '', youtrackToken: '' }, { onSuccess: clearFields });
    return (
        <IntegrationRow
            last={last}
            connected={hasYouTrackConfig}
            name="YouTrack"
            description={hasYouTrackConfig ? t('integ.youtrack_connected') : t('integ.youtrack_desc')}
            icon={<svg viewBox="0 0 70 70" fill="none" className="w-[22px] h-[22px]"><defs><linearGradient id="yt_g1" x1="12" y1="58" x2="58" y2="12" gradientUnits="userSpaceOnUse"><stop stopColor="#FC3791" /><stop offset="0.52" stopColor="#9B4AB0" /><stop offset="1" stopColor="#6166E8" /></linearGradient></defs><rect width="70" height="70" rx="14" fill="url(#yt_g1)" /><path d="M16 18h38v34H16z" fill="white" fillOpacity="0.9" /><path d="M20 25h20v3H20zM20 32h28v3H20zM20 39h14v3H20z" fill="url(#yt_g1)" /></svg>}
        >
            <div className="space-y-2">
                <input type="text" value={url} onChange={e => setUrl(e.target.value)}
                    placeholder={hasYouTrackConfig ? '••••••••••••••••' : 'https://your-instance.youtrack.cloud'}
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!" />
                <ApiKeyField
                    placeholder={hasYouTrackConfig ? '••••••••••••••••' : t('connections.field_permanent_token', 'Permanent token')}
                    value={token} onChange={e => setToken(e.target.value)} onSave={handleSave} saving={saving}
                    hint={<>{t('settings.integrations.token_from', 'Token from')} <a href="https://www.jetbrains.com/help/youtrack/server/manage-permanent-token.html" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.youtrack_path', 'YouTrack → Profile → Authentication')}</a></>}
                />
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasYouTrackConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};
// ── SignRequest ───────────────────────────────────────────────────────────────
const SignRequestIntegration = ({ hasSignRequestConfig, onSaved, last }: SignRequestIntegrationProps) => {
    const { t } = useTranslation();
    const [subdomain, setSubdomain] = useState('');
    const [token, setToken] = useState('');
    const { saving, disconnecting, error, save, disconnect } = useUserSettingSave(onSaved);
    const clearFields = () => { setSubdomain(''); setToken(''); };
    const handleSave = () => {
        if (!subdomain.trim() && !token.trim()) return;
        const body: { signrequestSubdomain?: string; signrequestToken?: string } = {};
        if (subdomain.trim()) body.signrequestSubdomain = subdomain.trim();
        if (token.trim()) body.signrequestToken = token;
        save(body, { onSuccess: clearFields });
    };
    const handleDisconnect = () => disconnect({ signrequestSubdomain: '', signrequestToken: '' }, { onSuccess: clearFields });
    return (
        <IntegrationRow
            last={last}
            connected={hasSignRequestConfig}
            name="SignRequest"
            description={hasSignRequestConfig ? t('integ.signrequest_connected') : t('integ.signrequest_desc')}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="url(#sr_g)" /><path d="M7 14.5c0-1 .8-2 2.5-2 1.5 0 2.2.7 3 1.2.8.5 1.5 1.3 3 1.3 1.5 0 2.5-1 2.5-2" stroke="white" strokeWidth="1.8" strokeLinecap="round" fill="none" /><path d="M8 8h8M8 11h5" stroke="white" strokeWidth="1.5" strokeLinecap="round" /><defs><linearGradient id="sr_g" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#22c55e" /><stop offset="1" stopColor="#16a34a" /></linearGradient></defs></svg>}
        >
            <div className="space-y-2">
                <input type="text" value={subdomain} onChange={e => setSubdomain(e.target.value)}
                    placeholder={hasSignRequestConfig ? '••••••••••••••••' : t('settings.integrations.signrequest_subdomain_placeholder', 'your-team (team subdomain)')}
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!" />
                <ApiKeyField
                    placeholder={hasSignRequestConfig ? '••••••••••••••••' : t('connections.field_api_token', 'API token')}
                    value={token} onChange={e => setToken(e.target.value)} onSave={handleSave} saving={saving}
                    hint={<>{t('settings.integrations.get_token_from', 'Get your token from')} <a href="https://signrequest.com/api/v1/api-docs/" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.signrequest_path', 'SignRequest → API Settings')}</a>{t('settings.integrations.signrequest_sandbox', '. Use your sandbox team subdomain for testing.')}</>}
                />
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasSignRequestConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

// ── Gamma ─────────────────────────────────────────────────────────────────────
const GammaIntegration = ({ hasGammaKey, onSaved, last }: GammaIntegrationProps) => {
    const { t } = useTranslation();
    return (
        <SimpleApiKeyIntegration
            last={last}
            connected={hasGammaKey}
            name="Gamma"
            payloadKey="gammaApiKey"
            description={t('integ.gamma_desc')}
            connectedDescription={t('integ.gamma_connected')}
            placeholder={t('settings.integrations.gamma_key_placeholder', 'Enter your Gamma API key')}
            onSaved={onSaved}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="url(#gamma_g)" /><path d="M7 8h10v1.5H7zM7 12h8v1.5H7zM7 16h5v1.5H7z" fill="white" fillOpacity="0.9" /><defs><linearGradient id="gamma_g" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse"><stop stopColor="#6366F1" /><stop offset="1" stopColor="#A855F7" /></linearGradient></defs></svg>}
            hint={<>{t('settings.integrations.get_key_from_short', 'Get key from')} <a href="https://gamma.app/settings" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">gamma.app/settings</a> {t('settings.integrations.gamma_api_tokens', '→ API Tokens')}</>}
        />
    );
};

// ── AFAS Profit ───────────────────────────────────────────────────────────────
// Read-only ERP access via an AFAS AppConnector token. The member number forms
// the API subdomain ({nr}.rest.afas.online) — digits only, validated server-side.
const AFASIntegration = ({ hasAfasConfig, onSaved, last }: AFASIntegrationProps) => {
    const { t } = useTranslation();
    const [memberNumber, setMemberNumber] = useState('');
    const [token, setToken] = useState('');
    const [envType, setEnvType] = useState('production');
    const [envTouched, setEnvTouched] = useState(false);
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);
    const handleSave = () => {
        if (!memberNumber.trim() && !token.trim() && !envTouched) return;
        // First connect needs both secrets — a token-only save would store a
        // half-configured integration that still shows as disconnected.
        if (!hasAfasConfig && (!memberNumber.trim() || !token.trim())) {
            setError(t('integ.afas_need_both'));
            return;
        }
        const body: { afasMemberNumber?: string; afasToken?: string; afasEnvType?: string } = {};
        if (memberNumber.trim()) body.afasMemberNumber = memberNumber.trim();
        if (token.trim()) body.afasToken = token.trim();
        // Only send the environment when first connecting or explicitly
        // changed — otherwise a token-only update would silently reset a
        // saved test/accept environment back to the select's default.
        if (!hasAfasConfig || envTouched) body.afasEnvType = envType;
        save(body, { onSuccess: () => { setMemberNumber(''); setToken(''); setEnvTouched(false); } });
    };
    const handleDisconnect = () => disconnect(
        { afasMemberNumber: '', afasToken: '', afasEnvType: '' },
        { onSuccess: () => { setMemberNumber(''); setToken(''); setEnvType('production'); setEnvTouched(false); } },
    );
    return (
        <IntegrationRow
            last={last}
            connected={hasAfasConfig}
            name="AFAS Profit"
            description={hasAfasConfig ? t('integ.afas_connected') : t('integ.afas_desc')}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#E30613" /><path d="M12 6.5L7 17.5h2.3l1-2.4h3.4l1 2.4H17L12 6.5zm0 4.1l1 2.5h-2l1-2.5z" fill="white" /></svg>}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.afas_step1')}</li>
                    <li>{t('integ.afas_step2')}</li>
                    <li>{t('integ.afas_step3')}</li>
                </ol>
                <div className="flex gap-2">
                    <input type="text" inputMode="numeric" value={memberNumber}
                        onChange={e => setMemberNumber(e.target.value.replace(/\D/g, ''))}
                        placeholder={hasAfasConfig ? '••••••' : t('integ.afas_member_placeholder')}
                        aria-label={t('integ.afas_member_label')}
                        className="flex-1 px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!" />
                    <select value={envType}
                        onChange={e => { setEnvType(e.target.value); setEnvTouched(true); }}
                        aria-label={t('integ.afas_env_label')}
                        className="px-3 py-2 rounded-lg border outline-none text-[13px] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!">
                        <option value="production">{t('integ.afas_env_production')}</option>
                        <option value="test">{t('integ.afas_env_test')}</option>
                        <option value="accept">{t('integ.afas_env_accept')}</option>
                    </select>
                </div>
                <ApiKeyField
                    placeholder={hasAfasConfig ? '••••••••••••••••' : t('integ.afas_token_placeholder')}
                    value={token} onChange={e => setToken(e.target.value)} onSave={handleSave} saving={saving}
                    canSave={!!(token.trim() || memberNumber.trim() || envTouched)}
                    hint={<>{t('settings.integrations.afas_help', 'AFAS Help:')} <a href="https://help.afas.nl/help/NL/SE/App_Cnr_Rest_Token.htm" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.afas_link', 'Create an app connector & token')}</a></>}
                />
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasAfasConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

// ── NMBRS ───────────────────────────────────────────────────────────────────
// Read-only payroll/HR access. Supports both NMBRS APIs: SOAP (login email +
// token) and REST (Bearer token). The subdomain is the tenant; non-secret
// fields pre-fill from the saved config, the token is never returned.
const NMBRSIntegration = ({ hasNmbrsConfig, apiMode: initialMode, subdomain: initialSub, email: initialEmail, env: initialEnv, onSaved, last }: NMBRSIntegrationProps) => {
    const { t } = useTranslation();
    const [apiMode, setApiMode] = useState(initialMode || 'soap');
    const [subdomain, setSubdomain] = useState(initialSub || '');
    const [email, setEmail] = useState(initialEmail || '');
    const [token, setToken] = useState('');
    const [env, setEnv] = useState(initialEnv || 'production');
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);
    const handleSave = () => {
        // First connect needs subdomain + token (+ login email for the SOAP API);
        // a partial save would store a half-configured integration.
        if (!hasNmbrsConfig && (!subdomain.trim() || !token.trim() || (apiMode === 'soap' && !email.trim()))) {
            setError(t('integ.nmbrs_need_fields'));
            return;
        }
        const body: Record<string, string> = { nmbrsApiMode: apiMode, nmbrsEnv: env };
        if (subdomain.trim()) body.nmbrsSubdomain = subdomain.trim();
        if (email.trim()) body.nmbrsEmail = email.trim();
        if (token.trim()) body.nmbrsToken = token.trim();
        save(body, { onSuccess: () => setToken('') });
    };
    const handleDisconnect = () => disconnect(
        { nmbrsApiMode: '', nmbrsSubdomain: '', nmbrsEmail: '', nmbrsToken: '', nmbrsEnv: '' },
        { onSuccess: () => { setSubdomain(''); setEmail(''); setToken(''); setApiMode('soap'); setEnv('production'); } },
    );
    const inputCls = "flex-1 px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors";
    const inputStyle = { background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' };
    return (
        <IntegrationRow
            last={last}
            connected={hasNmbrsConfig}
            name="NMBRS"
            description={hasNmbrsConfig ? t('integ.nmbrs_connected') : t('integ.nmbrs_desc')}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#00C389" /><path d="M7 16.5v-9h1.9v1.1c.45-.8 1.3-1.3 2.4-1.3 1.05 0 1.85.42 2.3 1.2.5-.78 1.4-1.2 2.45-1.2 1.95 0 2.95 1.2 2.95 3.2v6H19v-5.6c0-1-.35-1.75-1.4-1.75-1 0-1.5.78-1.5 1.8v5.55h-2v-5.6c0-1-.35-1.75-1.4-1.75-1 0-1.5.78-1.5 1.8v5.55H7z" fill="white" /></svg>}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.nmbrs_step1')}</li>
                    <li>{t('integ.nmbrs_step2')}</li>
                    <li>{t('integ.nmbrs_step3')}</li>
                </ol>
                <div className="flex gap-2">
                    <select value={apiMode} onChange={e => setApiMode(e.target.value)} aria-label={t('integ.nmbrs_mode_label')}
                        className="px-3 py-2 rounded-lg border outline-none text-[13px]" style={inputStyle}>
                        <option value="soap">{t('integ.nmbrs_mode_soap')}</option>
                        <option value="rest">{t('integ.nmbrs_mode_rest')}</option>
                    </select>
                    <select value={env} onChange={e => setEnv(e.target.value)} aria-label={t('integ.nmbrs_env_label')}
                        className="px-3 py-2 rounded-lg border outline-none text-[13px]" style={inputStyle}>
                        <option value="production">{t('integ.nmbrs_env_production')}</option>
                        <option value="sandbox">{t('integ.nmbrs_env_sandbox')}</option>
                    </select>
                </div>
                <input type="text" value={subdomain}
                    onChange={e => setSubdomain(e.target.value.trim())}
                    placeholder={t('integ.nmbrs_subdomain_placeholder')}
                    aria-label={t('integ.nmbrs_subdomain_label')}
                    className={inputCls} style={inputStyle} />
                {apiMode === 'soap' && (
                    <input type="email" value={email}
                        onChange={e => setEmail(e.target.value)}
                        placeholder={t('integ.nmbrs_email_placeholder')}
                        aria-label={t('integ.nmbrs_email_label')}
                        className={inputCls} style={inputStyle} />
                )}
                <ApiKeyField
                    placeholder={hasNmbrsConfig ? '••••••••••••••••' : t('integ.nmbrs_token_placeholder')}
                    value={token} onChange={e => setToken(e.target.value)} onSave={handleSave} saving={saving}
                    canSave={!!(token.trim() || subdomain.trim() || email.trim())}
                    hint={<>{t('settings.integrations.nmbrs_help', 'NMBRS Help:')} <a href="https://support.nmbrs.nl/hc/nl/articles/360010686800-Connect-Nmbrs-with-an-API-token" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.nmbrs_link', 'Create an API token')}</a></>}
                />
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasNmbrsConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

// ── GitHub ────────────────────────────────────────────────────────────────────
const GitHubIntegration = ({ onSaved, last }: GitHubIntegrationProps) => {
    const { t } = useTranslation();
    const [token, setToken] = useState('');
    const [connected, setConnected] = useState(false);
    const [username, setUsername] = useState<string | null>(null);
    // GitHub connect/disconnect hit dedicated endpoints (not /ai/user-settings)
    // and read the response (username), so they pass endpoint + onSuccess to the
    // shared hook. Error handling is unified to the visible `error` state (this
    // used to be an alert()).
    const { saving, disconnecting, error, save, disconnect } = useUserSettingSave(onSaved);
    const checkStatus = async () => {
        try {
            const res = await request(`${API_BASE}/api/integrations/github/status`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) { const data = await res.json(); setConnected(data.connected); setUsername(data.username); }
        } catch (err) { logger.debug('ignore', err); }
    };
    React.useEffect(() => { checkStatus(); }, []);
    const handleSave = () => {
        if (!token.trim()) return;
        save({ token: token.trim() }, {
            endpoint: `${API_BASE}/api/integrations/github/connect`,
            fallback: 'Failed to connect',
            onSuccess: (data) => { setConnected(true); setUsername(data.username as string); setToken(''); },
        });
    };
    const handleDisconnect = () => disconnect(null, {
        endpoint: `${API_BASE}/api/integrations/github/disconnect`,
        onSuccess: () => { setConnected(false); setUsername(null); },
    });
    return (
        <IntegrationRow
            last={last}
            connected={connected}
            name="GitHub"
            description={connected ? t('integ.github_connected', { username: username || 'user' }) : t('integ.github_desc')}
            icon={<svg viewBox="0 0 24 24" fill="currentColor" className="w-[20px] h-[20px] [color:var(--text-primary)]"><path d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.166 6.839 9.489.5.092.682-.217.682-.482 0-.237-.009-.866-.013-1.7-2.782.604-3.369-1.341-3.369-1.341-.454-1.155-1.11-1.462-1.11-1.462-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.163 22 16.418 22 12c0-5.523-4.477-10-10-10z" /></svg>}
        >
            {!connected ? (
                <ApiKeyField
                    placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
                    value={token} onChange={e => setToken(e.target.value)} onSave={handleSave} saving={saving}
                    hint={<>{t('settings.integrations.create_token_at', 'Create token at')} <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">github.com/settings/tokens</a> {t('settings.integrations.github_with', 'with')} <strong>repo</strong> {t('settings.integrations.github_scope', 'scope')}</>}
                />
            ) : (
                <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />
            )}
            {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
        </IntegrationRow>
    );
};

// ── Nextcloud ─────────────────────────────────────────────────────────────────
// Stores a username + app password used by Nextcloud-aware components for
// WebDAV / OCS Basic auth. Manually-generated app passwords (Nextcloud
// Settings → Security → Devices & sessions) are recommended over OAuth-minted
// ones, which inherit the access-token TTL (~10 min).
const NextcloudIntegration = ({ hasNextcloudAppPassword, isNextcloudUser, isConnectorUser, nextcloudUrl: savedNextcloudUrl, onSaved, last }: NextcloudIntegrationProps) => {
    const { t } = useTranslation();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [url, setUrl] = useState(savedNextcloudUrl || '');
    const [autoCreating, setAutoCreating] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    // Nextcloud uses dedicated /auth/* endpoints, so save/disconnect pass a
    // custom endpoint (+ DELETE method) to the shared hook. `notice` stays local
    // for the auto-create (OAuth) flow, which surfaces info/warnings too.
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);

    // Keep the URL field in sync once the saved value arrives (status loads after mount)
    // and after a save re-fetches it. Username/password stay blank — they're write-only.
    React.useEffect(() => { setUrl(savedNextcloudUrl || ''); }, [savedNextcloudUrl]);

    // When the user signs into Bee Flow via the Nextcloud ExApp connector,
    // every NC call is proxied back through the connector with AppAPI
    // shared-secret + impersonation. There's no app password to enter and
    // nothing the user can disconnect — the binding lives on the org level.
    if (isConnectorUser) {
        // Expanding the row reveals the per-user access scope — the row
        // itself stays as quiet as before ("zero pixels until opened").
        return (
            <IntegrationRow
                last={last}
                connected
                name="Nextcloud"
                description={t('integ.nextcloud_connector', 'Connected via Bee Flow Nextcloud connector — files, calendar, mail and more work in chat without extra setup.')}
                icon={<svg viewBox="0 0 32 32" fill="none" className="w-[20px] h-[20px]"><circle cx="16" cy="16" r="16" fill="#0082C9" /><path d="M11.5 11.2c-2 0-3.7 1.4-4.2 3.3a3.5 3.5 0 1 0 0 3 4.4 4.4 0 0 0 7 1.7l1.5-1.4 1.6 1.4a4.4 4.4 0 0 0 7-1.7 3.5 3.5 0 1 0 0-3 4.4 4.4 0 0 0-7-1.7l-1.6 1.4-1.5-1.4a4.4 4.4 0 0 0-2.8-1.6zm0 2.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zm9 0a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" fill="white" /></svg>}
            >
                <NcScopeSection />
            </IntegrationRow>
        );
    }

    const handleSave = () => {
        if (!username.trim() || !password.trim()) return;
        setNotice(null);
        save(
            { username: username.trim(), password: password.trim(), url: url.trim() },
            {
                endpoint: `${API_BASE}/auth/save-app-password`,
                onSuccess: () => { setUsername(''); setPassword(''); },
            },
        );
    };

    const autoCreate = async () => {
        setAutoCreating(true); setNotice(null); setError(null);
        try {
            const { ok, body: data } = await postForBody(`${API_BASE}/auth/create-app-password`, { method: 'POST' });
            if (ok) {
                onSaved();
                if (data.warning) setNotice(data.warning);
            } else {
                setNotice(data.error || t('integ.nextcloud_autocreate_failed', 'Failed to create app password'));
            }
        } catch (e) { console.error(e); setNotice((e as Error).message); }
        setAutoCreating(false);
    };

    const handleDisconnect = () => disconnect(null, { endpoint: `${API_BASE}/auth/app-password`, method: 'DELETE' });

    return (
        <IntegrationRow
            last={last}
            connected={hasNextcloudAppPassword}
            name="Nextcloud"
            description={hasNextcloudAppPassword
                ? t('integ.nextcloud_connected', 'App password saved — files & WebDAV available to agents')
                : t('integ.nextcloud_desc', 'Connect Nextcloud for file/WebDAV access in chat')}
            icon={<svg viewBox="0 0 32 32" fill="none" className="w-[20px] h-[20px]"><circle cx="16" cy="16" r="16" fill="#0082C9" /><path d="M11.5 11.2c-2 0-3.7 1.4-4.2 3.3a3.5 3.5 0 1 0 0 3 4.4 4.4 0 0 0 7 1.7l1.5-1.4 1.6 1.4a4.4 4.4 0 0 0 7-1.7 3.5 3.5 0 1 0 0-3 4.4 4.4 0 0 0-7-1.7l-1.6 1.4-1.5-1.4a4.4 4.4 0 0 0-2.8-1.6zm0 2.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8zm9 0a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8z" fill="white" /></svg>}
        >
            <div className="space-y-2">
                <input
                    type="url"
                    value={url}
                    onChange={e => setUrl(e.target.value)}
                    placeholder={t('integ.nextcloud_url_placeholder', 'Nextcloud URL (e.g. https://cloud.example.com)')}
                    aria-label={t('integ.nextcloud_url_placeholder', 'Nextcloud URL (e.g. https://cloud.example.com)')}
                    autoComplete="off"
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!"
                />
                <input
                    type="text"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                    placeholder={hasNextcloudAppPassword ? '••••••••' : t('integ.nextcloud_username_placeholder', 'Nextcloud username')}
                    aria-label={t('integ.nextcloud_username_placeholder', 'Nextcloud username')}
                    autoComplete="off"
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!"
                />
                <ApiKeyField
                    placeholder={hasNextcloudAppPassword ? '••••••••••••••••' : t('integ.nextcloud_password_placeholder', 'App password')}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    onSave={handleSave}
                    saving={saving}
                    hint={t('integ.nextcloud_hint', 'Generate at Nextcloud → Settings → Security → Devices & sessions.')}
                />
                {isNextcloudUser && (
                    <button
                        onClick={autoCreate}
                        disabled={autoCreating}
                        className="px-4 py-2 rounded-lg text-[13px] font-medium transition-opacity disabled:opacity-50 [background:var(--bg-primary)] [color:var(--text-primary)]! [border:1px_solid_var(--border-default)]"
                    >
                        {autoCreating ? '…' : t('integ.nextcloud_autocreate', 'Auto-create from OAuth session (short-lived)')}
                    </button>
                )}
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {notice && (
                    <p className="text-[11px] text-[var(--text-muted)]">{notice}</p>
                )}
                {hasNextcloudAppPassword && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
                {hasNextcloudAppPassword && (
                    <div className="pt-3 [border-top:1px_solid_var(--border-subtle)]">
                        <NcScopeSection />
                    </div>
                )}
            </div>
        </IntegrationRow>
    );
};

// ── MCP Servers ───────────────────────────────────────────────────────────────
// The page loads the list, not the rows: the Developer group has to know
// whether it has anything to show before it draws its heading and frame.
const useMcpCredentialServers = (enabled: boolean) => {
    const [servers, setServers] = useState<McpCredentialServer[]>([]);
    const load = React.useCallback(async () => {
        try {
            const res = await request(`${API_BASE}/ai/mcp-servers/user-credentials`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) { const data = await res.json(); setServers(data.servers || []); }
        } catch (err) { logger.debug('ignore', err); }
    }, []);
    React.useEffect(() => { if (enabled) load(); }, [enabled, load]);
    return { servers: enabled ? servers : [], reload: load };
};

const McpCredentialRows = ({ servers, reload, onSaved, last }: McpCredentialRowsProps) => {
    const { t } = useTranslation();
    const [credValues, setCredValues] = useState<Record<string, string>>({});
    const [saving, setSaving] = useState<string | null>(null);
    const saveCred = async (serverId: string, credKey: string) => {
        const stateKey = `${serverId}:${credKey}`;
        const value = credValues[stateKey];
        if (!value?.trim()) return;
        setSaving(stateKey);
        try {
            const res = await mutate(`${API_BASE}/ai/mcp-servers/user-credentials`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ serverId, credKey, value: value.trim() }),
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) { setCredValues(prev => ({ ...prev, [stateKey]: '' })); reload(); onSaved?.(); }
            else toast.error(t('common.save_failed', 'Save failed'));
        } catch {
            // The typed value stays in the field, so the user can retry.
            toast.error(t('common.save_failed', 'Save failed'));
        }
        setSaving(null);
    };
    return (
        <>
            {servers.map((server, si) => (
                <IntegrationRow
                    key={server.id}
                    last={last && si === servers.length - 1}
                    connected={server.allConfigured}
                    name={server.name}
                    description={server.allConfigured ? t('integ.mcp_connected', { toolCount: server.toolCount }) : t('integ.mcp_desc', { toolCount: server.toolCount })}
                    icon={<svg viewBox="0 0 24 24" fill="none" className="w-[18px] h-[18px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="url(#mcp_g)" /><path d="M8 12h8M12 8v8" stroke="white" strokeWidth="2" strokeLinecap="round" /><defs><linearGradient id="mcp_g" x1="2" y1="2" x2="22" y2="22"><stop stopColor="#6366F1" /><stop offset="1" stopColor="#8B5CF6" /></linearGradient></defs></svg>}
                >
                    <div className="space-y-2">
                        {server.credentials.map(cred => {
                            const stateKey = `${server.id}:${cred.key}`;
                            return (
                                <div key={cred.key}>
                                    <ApiKeyField
                                        placeholder={cred.configured ? '••••••••••••••••' : t('integ.mcp_enter_credential', 'Enter {label}', { label: cred.label || cred.key })}
                                        value={credValues[stateKey] || ''}
                                        onChange={e => setCredValues(prev => ({ ...prev, [stateKey]: e.target.value }))}
                                        onSave={() => saveCred(server.id, cred.key)}
                                        saving={saving === stateKey}
                                    />
                                    {cred.configured && <p className="text-[10px] mt-0.5 text-[var(--success-ink)]">{t('integ.mcp_configured', '✓ Configured')}{cred.description ? ` — ${cred.description}` : ''}</p>}
                                </div>
                            );
                        })}
                    </div>
                </IntegrationRow>
            ))}
        </>
    );
};

// ── Group frame ───────────────────────────────────────────────────────────────
// `rows` is a list of [key, render] pairs with falsy entries for rows that are
// not shown; render(last) draws one row, so the last-row flag follows from the
// list instead of being spelled out per row. No rows, no heading.
const IntegrationGroup = ({ label, rows }: IntegrationGroupProps) => {
    const shown = rows.filter(Boolean) as [string, (last: boolean) => React.ReactNode][];
    if (shown.length === 0) return null;
    return (
        <div className="space-y-1.5">
            <GroupLabel>{label}</GroupLabel>
            <div className="rounded-xl overflow-hidden border border-[var(--border-subtle)]">
                {shown.map(([key, render], i) => <React.Fragment key={key}>{render(i === shown.length - 1)}</React.Fragment>)}
            </div>
        </div>
    );
};

// ── IntegrationsSection ───────────────────────────────────────────────────────
// Settings → Connections: the user's own credentials. Groups follow the
// integration catalogue's CATEGORY_ORDER (config/integrationCatalog.js), the
// order the consumer Integrations page and the organisation's access matrix
// use, and every integration sits under its catalogue category.
const IntegrationsSection = ({ statuses, onSaved, user }: IntegrationsSectionProps) => {
    const { t } = useTranslation();
    // Only list integrations the user's organisation actually has access to: the
    // plan-trimmed EFFECTIVE entitlement set (subscription-included AND granted in
    // org settings), not the plan-agnostic org allow-list. While the snapshot is
    // still loading — or if it failed to load — fall back to showing everything so
    // the page never flashes (or stays) empty.
    const { effective, loading, error } = useEntitlements() || {};
    const effectiveIntegrations = useMemo(() => new Set(effective?.integration || []), [effective]);
    const isEnabled = (id: string) => !!(loading || error || effectiveIntegrations.has(id));

    // BFSF-255: show the Google Workspace connect tile whenever at least one
    // Google integration is in the org's effective entitlement set.
    const showGoogle = ['gmail', 'google-calendar', 'google-drive'].some(isEnabled);
    // Nextcloud-bound users always see the card so they can manage their link.
    // `provider` (login payload) covers connector + OAuth NC users synchronously,
    // so the card never depends on the async app-password-status fetch, which can
    // fail-closed; `statuses.isNextcloudUser` is just a belt-and-braces fallback.
    const isNcUser = user?.provider === 'nextcloud_connector' || user?.provider === 'nextcloud'
        || !!user?.ncOrg?.instanceId || !!statuses?.isNextcloudUser;
    // For everyone else, only show it when the org actually enables Nextcloud.
    // Nextcloud is org-exempt in the resolver (granted to all via the
    // isNcCapability bypass), so effective.integration / isEnabled('nextcloud')
    // is always true and can't tell enabled from disabled. Gate on the org's
    // enabled-integrations allow-list from the login payload instead: null/absent
    // = unrestricted (show it); a list must contain 'nextcloud'.
    const orgEnabledIntegrations = (user as (SettingsUser & { enabledIntegrations?: string[] | null }) | null | undefined)?.enabledIntegrations;
    const orgEnablesNextcloud = !Array.isArray(orgEnabledIntegrations) || orgEnabledIntegrations.includes('nextcloud');
    const showNextcloud = isNcUser || orgEnablesNextcloud;
    // MCP servers are opt-in per plan; load the per-server credentials only
    // when the effective set includes at least one installed server.
    const showMcp = loading || error || (effective?.integration || []).some(id => id.startsWith('mcp:'));
    const { servers: mcpServers, reload: reloadMcp } = useMcpCredentialServers(!!showMcp);

    return (
        <div className="space-y-6">
            <h2 className="text-lg font-semibold text-[var(--text-primary)]">{t('settings.connections', 'Connections')}</h2>

            {/* Named connections + sharing (bring-your-own vs lend). Reusable
                HTTP credentials for the http_request step live here too. */}
            <ConnectionsManager />

            {/* Google Workspace (BFSF-255) */}
            <IntegrationGroup label={t('settings.integrations_google_workspace', 'Google Workspace')} rows={[
                showGoogle && ['google', (last: boolean): React.ReactNode => <GoogleWorkspaceIntegration onSaved={() => onSaved('google')} last={last} />],
            ]} />

            {/* Microsoft 365: shown when a Microsoft app is in the effective set */}
            <Microsoft365Group isEnabled={isEnabled} onSaved={() => onSaved('microsoft')} />

            <IntegrationGroup label={t('settings.integrations_nextcloud', 'Nextcloud')} rows={[
                showNextcloud && ['nextcloud', (last: boolean): React.ReactNode => <NextcloudIntegration hasNextcloudAppPassword={statuses.hasNextcloudAppPassword as boolean | undefined} isNextcloudUser={statuses.isNextcloudUser as boolean | undefined} isConnectorUser={user?.provider === 'nextcloud_connector'} nextcloudUrl={statuses.nextcloudUrl as string | undefined} onSaved={() => onSaved('nextcloud')} last={last} />],
            ]} />

            {/* Developer, then the keys for the MCP servers the organisation
                added (MCP library), so the two MCP key lists sit together. */}
            <IntegrationGroup label={t('settings.integrations_developer')} rows={[
                isEnabled('youtrack') && ['youtrack', (last: boolean): React.ReactNode => <YouTrackIntegration hasYouTrackConfig={statuses.hasYouTrackConfig as boolean | undefined} onSaved={() => onSaved('youtrack')} last={last} />],
                isEnabled('github') && ['github', (last: boolean): React.ReactNode => <GitHubIntegration onSaved={() => onSaved('github')} last={last} />],
                mcpServers.length > 0 && ['mcp', (last: boolean): React.ReactNode => <McpCredentialRows servers={mcpServers} reload={reloadMcp} onSaved={() => onSaved('mcp')} last={last} />],
            ]} />
            <OrgMcpConnections />

            <IntegrationGroup label={t('settings.integrations_productivity')} rows={[
                isEnabled('fireflies') && ['fireflies', (last: boolean): React.ReactNode => <FirefliesIntegration hasFirefliesKey={statuses.hasFirefliesKey as boolean} onSaved={() => onSaved('fireflies')} last={last} />],
                isEnabled('signrequest') && ['signrequest', (last: boolean): React.ReactNode => <SignRequestIntegration hasSignRequestConfig={statuses.hasSignRequestConfig as boolean | undefined} onSaved={() => onSaved('signrequest')} last={last} />],
                isEnabled('gamma') && ['gamma', (last: boolean): React.ReactNode => <GammaIntegration hasGammaKey={statuses.hasGammaKey as boolean} onSaved={() => onSaved('gamma')} last={last} />],
                isEnabled('afas-profit') && ['afas-profit', (last: boolean): React.ReactNode => <AFASIntegration hasAfasConfig={statuses.hasAfasConfig as boolean | undefined} onSaved={() => onSaved('afas-profit')} last={last} />],
                isEnabled('vplan') && ['vplan', (last: boolean): React.ReactNode => <VplanIntegration hasVplanConfig={statuses.hasVplanConfig as boolean | undefined} onSaved={() => onSaved('vplan')} last={last} />],
                isEnabled('firebird') && ['firebird', (last: boolean): React.ReactNode => <FirebirdIntegration hasFirebirdConfig={statuses.hasFirebirdConfig as boolean | undefined} onSaved={() => onSaved('firebird')} last={last} />],
                isEnabled('scaleway-billing') && ['scaleway-billing', (last: boolean): React.ReactNode => <ScalewayBillingIntegration hasScalewayBillingConfig={!!statuses.hasScalewayBillingConfig} onSaved={() => onSaved('scaleway-billing')} last={last} />],
                isEnabled('nmbrs') && ['nmbrs', (last: boolean): React.ReactNode => <NMBRSIntegration hasNmbrsConfig={statuses.hasNmbrsConfig as boolean | undefined} apiMode={statuses.nmbrsApiMode as string | undefined} subdomain={statuses.nmbrsSubdomain as string | undefined} email={statuses.nmbrsEmail as string | undefined} env={statuses.nmbrsEnv as string | undefined} onSaved={() => onSaved('nmbrs')} last={last} />],
            ]} />

            {/* Health — special-category data, so it gets its own group rather
                than hiding among Productivity tiles. */}
            <IntegrationGroup label={t('settings.integrations_health', 'Health')} rows={[
                isEnabled('withings') && ['withings', (last: boolean): React.ReactNode => <WithingsIntegration onSaved={() => onSaved('withings')} last={last} />],
            ]} />

            <IntegrationGroup label={t('settings.integrations_social')} rows={[
                isEnabled('linkedin') && ['linkedin', (last: boolean): React.ReactNode => <LinkedInIntegration connected={statuses.linkedInConnected as boolean | undefined} linkedInName={statuses.linkedInName as string | undefined} hasLinkedInConfig={statuses.hasLinkedInConfig as boolean | undefined} onSaved={() => onSaved('linkedin')} last={last} />],
            ]} />
        </div>
    );
};

export default IntegrationsSection;
