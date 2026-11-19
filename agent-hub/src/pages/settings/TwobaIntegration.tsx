import { useState, type ChangeEvent } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { postForBody } from '../../api/postForBody';
import { openOAuthWindow, useOAuthIntegration } from '../../api/queries/oauthIntegration';
import { TwobaLogo } from '../../utils/integrationLogos.database';
import { IntegrationRow, DisconnectButton } from './IntegrationPrimitives';
import type { TwobaIntegrationProps } from './IntegrationsSection.types';
import { apiUrl } from '@/api/typedRequest';

// ── 2BA ───────────────────────────────────────────────────────────────────────
// Article data and net purchase prices from 2BA, computed from the condition
// files in the company's 2BA Online Condition Server. A client id and secret
// from 2BA, then a sign-in: the 2BA user name and password (saved sealed), or
// "Sign in with 2BA" in a popup (routes/integrations/twoba.mts). Secrets are
// never returned; a blank field on a connected card keeps the stored value.
const FIELD = 'w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]';
const SELECT = 'px-3 py-2 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]';
const ACTION = 'px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-opacity';
const MASK = '••••••••';

type Mode = 'password' | 'authorization_code';
type Values = { clientId: string; clientSecret: string; mode: Mode; username: string; password: string };

/** The typed values as the settings body; empty fields are left out, the mode always goes. */
function bodyOf(v: Values): Record<string, string> {
    const body: Record<string, string> = { twobaAuthMode: v.mode };
    if (v.clientId.trim()) body.twobaClientId = v.clientId.trim();
    if (v.clientSecret.trim()) body.twobaClientSecret = v.clientSecret.trim();
    if (v.mode === 'password' && v.username.trim()) body.twobaUsername = v.username.trim();
    if (v.mode === 'password' && v.password) body.twobaPassword = v.password;
    return body;
}

type TestResult = { ok: boolean; text: string };
type Translate = ReturnType<typeof useTranslation>['t'];

/** POST /ai/twoba/test with the typed values; the answer as the line the card shows. */
async function testConnection(values: Values, t: Translate): Promise<TestResult> {
    const failed = t('twoba.test_failed');
    try {
        const { body } = await postForBody(apiUrl('POST /ai/twoba/test'), { method: 'POST', body: JSON.stringify(bodyOf(values)), headers: { 'Content-Type': 'application/json' } });
        if (!body.ok) return { ok: false, text: typeof body.error === 'string' && body.error ? body.error : failed };
        const company = String(body.companyName ?? '');
        const database = body.databaseName ? String(body.databaseName) : '';
        return { ok: true, text: database ? t('twoba.test_ok', { company, database }) : t('twoba.test_ok_no_database', { company }) };
    } catch {
        return { ok: false, text: failed };
    }
}

function useConnectionTest(values: Values) {
    const { t } = useTranslation();
    const [state, setState] = useState<{ testing: boolean; result: TestResult | null }>({ testing: false, result: null });
    const run = async () => {
        setState({ testing: true, result: null });
        setState({ testing: false, result: await testConnection(values, t) });
    };
    return { testing: state.testing, result: state.result, run };
}

/** "Sign in with 2BA": the redirect address to register, the sign-in state, sign in / again. */
const TwobaSignIn = ({ onSaved }: { onSaved: () => void }) => {
    const { t } = useTranslation();
    const oauth = useOAuthIntegration('twoba', { callbackType: 'twoba-callback', refreshOnCallback: true, onSaved });
    const { status } = oauth;
    const [opening, setOpening] = useState(false);
    const [error, setError] = useState('');
    const signIn = async () => {
        setOpening(true); setError('');
        try {
            const res = await oauth.fetchAuthUrl();
            const data = await res.json().catch(() => ({}));
            if (!res.ok || !data.url) throw new Error(data.error || t('twoba.signin_error'));
            openOAuthWindow(data.url, 'twoba-oauth', 600, 760);
        } catch (e) {
            setError((e as Error)?.message || t('twoba.signin_error'));
        }
        setOpening(false);
    };
    if (!status) return null;
    const text = status.connected ? t('twoba.signed_in') : status.needsReauth ? t('twoba.needs_reauth') : t('twoba.not_signed_in');
    return (
        <div className="space-y-2">
            {status.redirectUri && <p className="text-[11px] break-all text-[var(--text-muted)]">{t('twoba.redirect_uri', { uri: status.redirectUri })}</p>}
            <p className={`text-[12px] ${status.needsReauth ? 'text-[var(--error-ink)]' : 'text-[var(--text-secondary)]'}`}>{text}</p>
            {status.configured && !status.connected && (
                <button type="button" onClick={signIn} disabled={opening}
                    className={`${ACTION} text-[var(--accent-primary-fg)] bg-[var(--accent-primary)]`}>
                    {opening ? t('twoba.signin_opening') : status.needsReauth ? t('twoba.signin_again') : t('twoba.signin')}
                </button>
            )}
            {status.connected && <DisconnectButton onDisconnect={() => { void oauth.disconnect(); }} disconnecting={oauth.disconnecting} />}
            {error && <p className="text-[11px] text-[var(--error-ink)]">{error}</p>}
        </div>
    );
};

/** The form state, its save (refusing a half first save) and the full disconnect. */
function useTwobaForm(p: TwobaIntegrationProps) {
    const { t } = useTranslation();
    const initialMode: Mode = p.authMode === 'authorization_code' ? 'authorization_code' : 'password';
    const empty = (mode: Mode): Values => ({ clientId: '', clientSecret: '', mode, username: '', password: '' });
    const [values, setValues] = useState<Values>(empty(initialMode));
    const settings = useUserSettingSave(p.onSaved);
    const oauth = useOAuthIntegration('twoba', { remoteStatus: false, onSaved: p.onSaved });
    const set = (key: keyof Values) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
    const typedClient = !!(values.clientId.trim() && values.clientSecret.trim());
    const typedAccount = !!(values.username.trim() && values.password);
    const complete = typedClient && (values.mode === 'authorization_code' || typedAccount);
    const changed = values.mode !== initialMode || Object.keys(bodyOf(values)).length > 1;
    const save = () => {
        if (!changed) return;
        if (!p.hasTwobaConfig && !complete) {
            settings.setError(t(values.mode === 'password' ? 'twoba.need_all' : 'twoba.need_client'));
            return;
        }
        settings.save(bodyOf(values), { onSuccess: () => setValues((v) => ({ ...empty(v.mode) })) });
    };
    const disconnect = () => {
        if (p.authMode === 'authorization_code') void oauth.disconnect(); // end the sign-in at 2BA too
        const cleared = { twobaClientId: '', twobaClientSecret: '', twobaAuthMode: '', twobaUsername: '', twobaPassword: '' };
        settings.disconnect(cleared, { onSuccess: () => setValues(empty('password')) });
    };
    return { values, set, save, disconnect, changed, complete, settings };
}

type Form = ReturnType<typeof useTwobaForm>;

/** Client id and secret, the sign-in choice and, for a password sign-in, the 2BA account. */
const TwobaFields = ({ p, form }: { p: TwobaIntegrationProps; form: Form }) => {
    const { t } = useTranslation();
    const { values, set } = form;
    const hint = (key: string) => (p.hasTwobaConfig ? MASK : t(key));
    return (
        <>
            <div className="flex gap-2">
                <input type="text" value={values.clientId} onChange={set('clientId')} autoComplete="off"
                    placeholder={hint('twoba.client_id_label')} aria-label={t('twoba.client_id_label')} className={`flex-1 ${FIELD}`} />
                <input type="password" value={values.clientSecret} onChange={set('clientSecret')} autoComplete="off" data-1p-ignore data-lpignore="true"
                    placeholder={hint('twoba.client_secret_label')} aria-label={t('twoba.client_secret_label')} className={`flex-1 ${FIELD}`} />
            </div>
            <select value={values.mode} onChange={set('mode')} aria-label={t('twoba.mode_label')} className={SELECT}>
                <option value="password">{t('twoba.mode_account')}</option>
                <option value="authorization_code">{t('twoba.mode_code')}</option>
            </select>
            {values.mode === 'password' && (
                <div className="flex gap-2">
                    <input type="text" value={values.username} onChange={set('username')} autoComplete="off"
                        placeholder={p.username || t('twoba.username_label')} aria-label={t('twoba.username_label')} className={`flex-1 ${FIELD}`} />
                    <input type="password" value={values.password} onChange={set('password')} autoComplete="new-password" data-1p-ignore data-lpignore="true"
                        placeholder={hint('twoba.password_label')} aria-label={t('twoba.password_label')} className={`flex-1 ${FIELD}`} />
                </div>
            )}
        </>
    );
};

const TwobaIntegration = (p: TwobaIntegrationProps) => {
    const { t } = useTranslation();
    const form = useTwobaForm(p);
    const { values, save, disconnect, changed, complete, settings } = form;
    const test = useConnectionTest(values);
    const signInShown = values.mode === 'authorization_code' && p.authMode === 'authorization_code' && !!p.hasTwobaConfig;
    return (
        <IntegrationRow last={p.last} connected={p.hasTwobaConfig} name="2BA" icon={<TwobaLogo size={20} />}
            description={p.hasTwobaConfig ? t('twoba.connected') : t('twoba.desc')}>
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('twoba.step1')}</li>
                    <li>{t('twoba.step2')}</li>
                    <li>{t('twoba.step3')}</li>
                </ol>
                <TwobaFields p={p} form={form} />
                <p className="text-[11px] text-[var(--text-muted)]">{t('twoba.scope_note')}</p>
                <div className="flex gap-2">
                    <button type="button" onClick={test.run} disabled={test.testing || !(p.hasTwobaConfig || complete)}
                        className={`${ACTION} bg-[var(--bg-primary)] text-[var(--text-primary)] border border-[var(--border-default)]`}>
                        {test.testing ? '…' : t('twoba.test')}
                    </button>
                    <button type="button" onClick={save} disabled={settings.saving || !changed}
                        className={`${ACTION} text-[var(--accent-primary-fg)] bg-[var(--accent-primary)]`}>
                        {settings.saving ? '…' : t('settings.save', 'Save')}
                    </button>
                </div>
                {test.result && <p className={`text-[11px] ${test.result.ok ? 'text-[var(--success-ink)]' : 'text-[var(--error-ink)]'}`}>{test.result.text}</p>}
                {settings.error && <p className="text-[11px] text-[var(--error-ink)]">{settings.error}</p>}
                {signInShown && <TwobaSignIn onSaved={p.onSaved} />}
                {p.hasTwobaConfig && <DisconnectButton onDisconnect={disconnect} disconnecting={settings.disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

export default TwobaIntegration;
