import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { API_BASE } from '../../utils/helpers';
import { postForBody } from '../../api/postForBody';
import { IntegrationRow, DisconnectButton } from './IntegrationPrimitives';
import type { FirebirdIntegrationProps } from './IntegrationsSection.types';

// ── Firebird database ─────────────────────────────────────────────────────────
// Read-only access to a Firebird database (typically Syntess Atrium). The
// server reads with SELECT in read-only transactions only; the form values are
// shape-checked server-side before they are stored. A blank field on an
// already-connected card keeps the stored value.
const CHARSETS = ['UTF8', 'NONE', 'WIN1252', 'ISO8859_1'];
const INPUT_CLASS = 'w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!';
const BUTTON_CLASS = 'px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-opacity';

interface TestResult { ok: boolean; text: string }

function useFirebirdForm(hasFirebirdConfig: boolean | undefined, onSaved: () => void) {
    const { t } = useTranslation();
    const [host, setHost] = useState('');
    const [port, setPort] = useState('');
    const [database, setDatabase] = useState('');
    const [user, setUser] = useState('');
    const [password, setPassword] = useState('');
    const [charset, setCharset] = useState('UTF8');
    const [charsetTouched, setCharsetTouched] = useState(false);
    const [testing, setTesting] = useState(false);
    const [testResult, setTestResult] = useState<TestResult | null>(null);
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);
    const clearFields = () => {
        setHost(''); setPort(''); setDatabase(''); setUser(''); setPassword('');
        setCharset('UTF8'); setCharsetTouched(false); setTestResult(null);
    };
    const filled = (): Record<string, string> => {
        const body: Record<string, string> = {};
        if (host.trim()) body.firebirdHost = host.trim();
        if (port.trim()) body.firebirdPort = port.trim();
        if (database.trim()) body.firebirdDatabase = database.trim();
        if (user.trim()) body.firebirdUser = user.trim();
        if (password) body.firebirdPassword = password;
        if (!hasFirebirdConfig || charsetTouched) body.firebirdCharset = charset;
        return body;
    };
    const anyInput = !!(host.trim() || port.trim() || database.trim() || user.trim() || password || charsetTouched);
    const handleSave = () => {
        if (!anyInput) return;
        // First connect needs all four required fields; a partial save would
        // store a half-configured integration that still shows as disconnected.
        if (!hasFirebirdConfig && !(host.trim() && database.trim() && user.trim() && password)) {
            setError(t('integ.firebird_need_all'));
            return;
        }
        save(filled(), { onSuccess: clearFields });
    };
    const handleDisconnect = () => disconnect(
        { firebirdHost: '', firebirdPort: '', firebirdDatabase: '', firebirdUser: '', firebirdPassword: '', firebirdCharset: '' },
        { onSuccess: clearFields },
    );
    const handleTest = async () => {
        setTesting(true);
        setTestResult(null);
        try {
            const { body } = await postForBody(`${API_BASE}/ai/firebird/test`, { method: 'POST', body: JSON.stringify(filled()), headers: { 'Content-Type': 'application/json' } });
            const version = String(body.server_version ?? '');
            const tables = String(body.table_count ?? '');
            setTestResult(body.ok
                ? { ok: true, text: t('integ.firebird_test_ok', { version, tables }) }
                : { ok: false, text: typeof body.error === 'string' && body.error ? body.error : t('integ.firebird_test_failed') });
        } catch {
            setTestResult({ ok: false, text: t('integ.firebird_test_failed') });
        }
        setTesting(false);
    };
    const required = !!(host.trim() && database.trim() && user.trim() && password);
    const canTest = hasFirebirdConfig || required;
    return {
        t, host, setHost, port, setPort, database, setDatabase, user, setUser, password, setPassword,
        charset, setCharset, setCharsetTouched, testing, testResult, saving, disconnecting, error, anyInput,
        canTest, handleSave, handleDisconnect, handleTest,
    };
}

const FirebirdIntegration = ({ hasFirebirdConfig, onSaved, last }: FirebirdIntegrationProps) => {
    const {
        t, host, setHost, port, setPort, database, setDatabase, user, setUser, password, setPassword,
        charset, setCharset, setCharsetTouched, testing, testResult, saving, disconnecting, error, anyInput,
        canTest, handleSave, handleDisconnect, handleTest,
    } = useFirebirdForm(hasFirebirdConfig, onSaved);
    const placeholderFor = (key: string, stored: string) => (hasFirebirdConfig ? stored : t(key));
    return (
        <IntegrationRow
            last={last}
            connected={hasFirebirdConfig}
            name="Firebird database"
            description={hasFirebirdConfig ? t('integ.firebird_connected') : t('integ.firebird_desc')}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#475569" /><ellipse cx="12" cy="7.5" rx="5.5" ry="2.2" fill="white" /><path d="M6.5 7.5v9c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2v-9c0 1.2-2.5 2.2-5.5 2.2s-5.5-1-5.5-2.2z" fill="white" fillOpacity="0.85" /><path d="M6.5 12c0 1.2 2.5 2.2 5.5 2.2s5.5-1 5.5-2.2" stroke="#475569" strokeWidth="1" /></svg>}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.firebird_step1')}</li>
                    <li>{t('integ.firebird_step2')}</li>
                    <li>{t('integ.firebird_step3')}</li>
                </ol>
                <div className="flex gap-2">
                    <input type="text" value={host} onChange={e => setHost(e.target.value)} autoComplete="off"
                        placeholder={placeholderFor('integ.firebird_host_placeholder', '••••••••')}
                        aria-label={t('integ.firebird_host_label')} className={`flex-1 ${INPUT_CLASS}`} />
                    <input type="text" inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))}
                        placeholder={t('integ.firebird_port_placeholder')}
                        aria-label={t('integ.firebird_port_label')} className="w-24 px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!" />
                </div>
                <input type="text" value={database} onChange={e => setDatabase(e.target.value)} autoComplete="off"
                    placeholder={placeholderFor('integ.firebird_database_placeholder', '••••••••')}
                    aria-label={t('integ.firebird_database_label')} className={INPUT_CLASS} />
                <div className="flex gap-2">
                    <input type="text" value={user} onChange={e => setUser(e.target.value)} autoComplete="off"
                        placeholder={placeholderFor('integ.firebird_user_placeholder', '••••••••')}
                        aria-label={t('integ.firebird_user_label')} className={`flex-1 ${INPUT_CLASS}`} />
                    <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                        autoComplete="off" data-1p-ignore data-lpignore="true"
                        placeholder={placeholderFor('integ.firebird_password_placeholder', '••••••••••••')}
                        aria-label={t('integ.firebird_password_label')} className={`flex-1 ${INPUT_CLASS}`} />
                </div>
                <select value={charset} onChange={e => { setCharset(e.target.value); setCharsetTouched(true); }}
                    aria-label={t('integ.firebird_charset_label')}
                    className="px-3 py-2 rounded-lg border outline-none text-[13px] [background:var(--bg-primary)] [border-color:var(--border-default)] [color:var(--text-primary)]!">
                    {CHARSETS.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('integ.firebird_readonly_note')} {t('settings.integrations.firebird_help', 'Firebird Help:')}{' '}
                    <a href="https://firebirdsql.org/en/documentation/" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.firebird_link', 'Firebird documentation')}</a>{' '}
                    {t('settings.integrations.firebird_plan', '(typical use: Syntess Atrium)')}
                </p>
                <div className="flex gap-2">
                    <button type="button" onClick={handleTest} disabled={testing || !canTest}
                        className={`${BUTTON_CLASS} [background:var(--bg-primary)] [color:var(--text-primary)]! [border:1px_solid_var(--border-default)]`}>
                        {testing ? '…' : t('integ.firebird_test')}
                    </button>
                    <button type="button" onClick={handleSave} disabled={saving || !anyInput}
                        className={`${BUTTON_CLASS} text-white bg-[var(--accent-primary)]`}>
                        {saving ? '…' : t('settings.save', 'Save')}
                    </button>
                </div>
                {testResult && <p className={`text-[11px] ${testResult.ok ? '[color:#059669]!' : '[color:#dc2626]!'}`}>{testResult.text}</p>}
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasFirebirdConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

export default FirebirdIntegration;
