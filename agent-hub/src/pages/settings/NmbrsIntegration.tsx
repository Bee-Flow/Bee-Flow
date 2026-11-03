import { useState } from 'react';
import type { ChangeEvent, ReactNode } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { openOAuthWindow, useOAuthIntegration } from '../../api/queries/oauthIntegration';
import { IntegrationRow, ApiKeyField, DisconnectButton } from './IntegrationPrimitives';
import type { NMBRSIntegrationProps } from './IntegrationsSection.types';

// ── NMBRS ───────────────────────────────────────────────────────────────────
// Read-only payroll/HR access over either NMBRS API. SOAP: login email + API
// token + subdomain. REST: the person's own Nmbrs app (subscription key,
// client ID and secret, saved as secrets and never returned) and an OAuth
// connection made in a popup (routes/integrations/nmbrs.js). Switching the API
// keeps every saved field, so a connection moves from SOAP to REST without
// losing its configuration. Nmbrs retires SOAP on 1 March 2027: a SOAP
// connection shows that date with the way over.

const INPUT_CLS = 'flex-1 w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]';
const SELECT_CLS = 'px-3 py-2 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]';
const MASK = '••••••••••••••••';
const SOAP_SUNSET = '2027-03-01';

const NmbrsIcon = () => (
    <svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#00C389" /><path d="M7 16.5v-9h1.9v1.1c.45-.8 1.3-1.3 2.4-1.3 1.05 0 1.85.42 2.3 1.2.5-.78 1.4-1.2 2.45-1.2 1.95 0 2.95 1.2 2.95 3.2v6H19v-5.6c0-1-.35-1.75-1.4-1.75-1 0-1.5.78-1.5 1.8v5.55h-2v-5.6c0-1-.35-1.75-1.4-1.75-1 0-1.5.78-1.5 1.8v5.55H7z" fill="white" /></svg>
);

/** The OAuth half of a REST connection: redirect address, status, connect / reconnect. */
const NmbrsRestConnect = ({ onSaved }: { onSaved: () => void }) => {
    const { t } = useTranslation();
    const oauth = useOAuthIntegration('nmbrs', { callbackType: 'nmbrs-callback', refreshOnCallback: true, onSaved });
    const { status } = oauth;
    const [connecting, setConnecting] = useState(false);
    const [error, setError] = useState('');
    const connect = async () => {
        setConnecting(true); setError('');
        try {
            const res = await oauth.fetchAuthUrl();
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) throw new Error(data.error || t('integ.nmbrs_connect_error'));
            openOAuthWindow(data.url, 'nmbrs-oauth', 600, 760);
        } catch (e) {
            setError((e as Error)?.message || t('integ.nmbrs_connect_error'));
        }
        setConnecting(false);
    };
    if (!status) return null;
    const text = status.connected ? t('integ.nmbrs_rest_connected')
        : status.needsReauth ? t('integ.nmbrs_needs_reauth') : t('integ.nmbrs_rest_not_connected');
    const label = connecting ? t('integ.nmbrs_opening') : status.needsReauth ? t('integ.nmbrs_reconnect') : t('integ.nmbrs_connect');
    return (
        <div className="space-y-2">
            {status.redirectUri && <p className="text-[11px] break-all text-[var(--text-muted)]">{t('integ.nmbrs_redirect_uri', { uri: status.redirectUri })}</p>}
            <p className={`text-[12px] ${status.needsReauth ? 'text-[#dc2626]' : 'text-[var(--text-secondary)]'}`}>{text}</p>
            {status.configured && !status.connected && (
                <button type="button" onClick={connect} disabled={connecting}
                    className="px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#00C389] disabled:opacity-60">{label}</button>
            )}
            {status.connected && <DisconnectButton onDisconnect={() => { void oauth.disconnect(); }} disconnecting={oauth.disconnecting} />}
            {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
        </div>
    );
};

interface Fields {
    apiMode: string; env: string; subdomain: string; email: string; token: string;
    subscriptionKey: string; clientId: string; clientSecret: string;
}
type SetField = (key: keyof Fields) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => void;

const SECRET_FIELDS: ReadonlyArray<[keyof Fields, string]> = [
    ['subdomain', 'nmbrsSubdomain'], ['email', 'nmbrsEmail'], ['token', 'nmbrsToken'],
    ['subscriptionKey', 'nmbrsSubscriptionKey'], ['clientId', 'nmbrsClientId'], ['clientSecret', 'nmbrsClientSecret'],
];

/** The form state, its save (refusing a half-configured first save) and the full disconnect. */
function useNmbrsForm(p: NMBRSIntegrationProps) {
    const { t } = useTranslation();
    const [f, setF] = useState<Fields>({
        apiMode: p.apiMode || 'soap', env: p.env || 'production', subdomain: p.subdomain || '', email: p.email || '',
        token: '', subscriptionKey: '', clientId: '', clientSecret: '',
    });
    const setField: SetField = (key) => (e) => setF((prev) => ({ ...prev, [key]: e.target.value }));
    const settings = useUserSettingSave(p.onSaved);
    const oauth = useOAuthIntegration('nmbrs', { remoteStatus: false, onSaved: p.onSaved });
    const has = (key: keyof Fields) => !!f[key].trim();
    const missing = f.apiMode === 'rest'
        ? !((p.hasNmbrsSubscriptionKey || has('subscriptionKey')) && (p.hasNmbrsClient || (has('clientId') && has('clientSecret'))))
        : !p.hasNmbrsConfig && !(has('subdomain') && has('token') && has('email'));
    const save = () => {
        if (missing) { settings.setError(t(f.apiMode === 'rest' ? 'integ.nmbrs_need_rest_fields' : 'integ.nmbrs_need_fields')); return; }
        const body: Record<string, string> = { nmbrsApiMode: f.apiMode, nmbrsEnv: f.env };
        for (const [key, name] of SECRET_FIELDS) if (has(key)) body[name] = f[key].trim();
        settings.save(body, { onSuccess: () => setF((prev) => ({ ...prev, token: '', subscriptionKey: '', clientId: '', clientSecret: '' })) });
    };
    const disconnectAll = () => {
        void oauth.disconnect(); // revoke the REST grant at Nmbrs too, if there is one
        const cleared = Object.fromEntries([['nmbrsApiMode', ''], ['nmbrsEnv', ''], ...SECRET_FIELDS.map(([, name]) => [name, ''])]);
        settings.disconnect(cleared, { onSuccess: () => setF({ apiMode: 'soap', env: 'production', subdomain: '', email: '', token: '', subscriptionKey: '', clientId: '', clientSecret: '' }) });
    };
    const canSave = f.apiMode !== (p.apiMode || 'soap') || SECRET_FIELDS.some(([key]) => has(key));
    return { f, setField, save, disconnectAll, canSave, settings };
}

const SoapFields = ({ f, setField, saveField }: { f: Fields; setField: SetField; saveField: ReactNode }) => {
    const { t } = useTranslation();
    return (
        <>
            <input type="text" value={f.subdomain} onChange={setField('subdomain')}
                placeholder={t('integ.nmbrs_subdomain_placeholder')} aria-label={t('integ.nmbrs_subdomain_label')} className={INPUT_CLS} />
            <input type="email" value={f.email} onChange={setField('email')}
                placeholder={t('integ.nmbrs_email_placeholder')} aria-label={t('integ.nmbrs_email_label')} className={INPUT_CLS} />
            {saveField}
        </>
    );
};

const RestFields = ({ f, setField, hasKey, hasClient, saveField }: { f: Fields; setField: SetField; hasKey?: boolean; hasClient?: boolean; saveField: ReactNode }) => {
    const { t } = useTranslation();
    return (
        <>
            <input type="password" value={f.subscriptionKey} onChange={setField('subscriptionKey')} autoComplete="off"
                placeholder={hasKey ? MASK : t('integ.nmbrs_subscription_key_placeholder')} aria-label={t('integ.nmbrs_subscription_key_placeholder')} className={INPUT_CLS} />
            <input type="text" value={f.clientId} onChange={setField('clientId')} autoComplete="off"
                placeholder={hasClient ? MASK : t('integ.nmbrs_client_id_placeholder')} aria-label={t('integ.nmbrs_client_id_placeholder')} className={INPUT_CLS} />
            {saveField}
        </>
    );
};

const NMBRSIntegration = (p: NMBRSIntegrationProps) => {
    const { t } = useTranslation();
    const { f, setField, save, disconnectAll, canSave, settings } = useNmbrsForm(p);
    const isRest = f.apiMode === 'rest';
    const saveField = isRest ? (
        <ApiKeyField placeholder={p.hasNmbrsClient ? MASK : t('integ.nmbrs_client_secret_placeholder')}
            value={f.clientSecret} onChange={setField('clientSecret')} onSave={save} saving={settings.saving} canSave={canSave} />
    ) : (
        <ApiKeyField placeholder={p.hasNmbrsConfig ? MASK : t('integ.nmbrs_token_placeholder')}
            value={f.token} onChange={setField('token')} onSave={save} saving={settings.saving} canSave={canSave}
            hint={<>{t('settings.integrations.nmbrs_help', 'NMBRS Help:')} <a href="https://support.nmbrs.nl/hc/nl/articles/360010686800-Connect-Nmbrs-with-an-API-token" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.nmbrs_link', 'Create an API token')}</a></>} />
    );
    // A saved SOAP connection carries the retirement date on its collapsed row too.
    const onSoap = !!p.hasNmbrsConfig && p.apiMode !== 'rest';
    const sunsetDate = new Date(SOAP_SUNSET).toLocaleDateString();
    const badge = onSoap
        ? <span className="text-[10px] px-1.5 py-0.5 rounded font-medium flex-shrink-0 border border-[#f59e0b] text-[#b45309]">{t('integ.nmbrs_soap_badge', { date: sunsetDate })}</span>
        : undefined;
    return (
        <IntegrationRow last={p.last} connected={p.hasNmbrsConfig} name="NMBRS" badge={badge}
            description={p.hasNmbrsConfig ? t('integ.nmbrs_connected') : t('integ.nmbrs_desc')} icon={<NmbrsIcon />}>
            <div className="space-y-2">
                {onSoap && (
                    <p role="status" className="px-3 py-2 rounded-lg text-[12px] border border-[#f59e0b] text-[var(--text-primary)] bg-[var(--bg-primary)]">
                        {t('integ.nmbrs_soap_sunset', { date: sunsetDate })}
                    </p>
                )}
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.nmbrs_step1')}</li>
                    {isRest ? <li>{t('integ.nmbrs_rest_steps')}</li> : <><li>{t('integ.nmbrs_step2')}</li><li>{t('integ.nmbrs_step3')}</li></>}
                </ol>
                <div className="flex gap-2">
                    <select value={f.apiMode} onChange={setField('apiMode')} aria-label={t('integ.nmbrs_mode_label')} className={SELECT_CLS}>
                        <option value="soap">{t('integ.nmbrs_mode_soap')}</option>
                        <option value="rest">{t('integ.nmbrs_mode_rest')}</option>
                    </select>
                    {!isRest && (
                        <select value={f.env} onChange={setField('env')} aria-label={t('integ.nmbrs_env_label')} className={SELECT_CLS}>
                            <option value="production">{t('integ.nmbrs_env_production')}</option>
                            <option value="sandbox">{t('integ.nmbrs_env_sandbox')}</option>
                        </select>
                    )}
                </div>
                {isRest
                    ? <RestFields f={f} setField={setField} hasKey={p.hasNmbrsSubscriptionKey} hasClient={p.hasNmbrsClient} saveField={saveField} />
                    : <SoapFields f={f} setField={setField} saveField={saveField} />}
                {isRest && p.apiMode === 'rest' && <NmbrsRestConnect onSaved={p.onSaved} />}
                {settings.error && <p className="text-[11px] [color:#dc2626]!">{settings.error}</p>}
                {p.hasNmbrsConfig && <DisconnectButton onDisconnect={disconnectAll} disconnecting={settings.disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

export default NMBRSIntegration;
