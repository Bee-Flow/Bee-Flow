import { useState, type ChangeEvent } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { postForBody } from '../../api/postForBody';
import { FrappeCrmLogo } from '../../utils/integrationLogos.database';
import { IntegrationRow, DisconnectButton } from './IntegrationPrimitives';
import type { FrappeCrmIntegrationProps } from './IntegrationsSection.types';
import { apiUrl } from '@/api/typedRequest';

// ── Frappe CRM ────────────────────────────────────────────────────────────────
// Leads, deals, contacts, tasks and notes in a Frappe CRM site (Frappe Cloud or
// self-hosted), through an API key and secret of one Frappe user. The server
// checks the address and the shape of both values before it stores them; a
// blank field on a connected card keeps the stored value.
const FIELD = 'w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!';
const ACTION = 'px-4 py-2 rounded-lg text-[13px] font-medium disabled:opacity-40 transition-opacity';
const MASK = '••••••••';

type Values = { url: string; apiKey: string; apiSecret: string };
const EMPTY: Values = { url: '', apiKey: '', apiSecret: '' };

/** The typed values as the settings body; empty fields are left out. */
function bodyOf(v: Values): Record<string, string> {
    const body: Record<string, string> = {};
    if (v.url.trim()) body.frappeCrmUrl = v.url.trim();
    if (v.apiKey.trim()) body.frappeCrmApiKey = v.apiKey.trim();
    if (v.apiSecret.trim()) body.frappeCrmApiSecret = v.apiSecret.trim();
    return body;
}

function useConnectionTest(values: Values) {
    const { t } = useTranslation();
    const [testing, setTesting] = useState(false);
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const run = async () => {
        setTesting(true);
        setResult(null);
        try {
            const { body } = await postForBody(apiUrl('POST /ai/frappe-crm/test'), { method: 'POST', body: JSON.stringify(bodyOf(values)), headers: { 'Content-Type': 'application/json' } });
            if (body.ok) setResult({ ok: true, text: t('integ.frappe_crm_test_ok', { user: String(body.user ?? '') }) });
            else setResult({ ok: false, text: typeof body.error === 'string' && body.error ? body.error : t('integ.frappe_crm_test_failed') });
        } catch {
            setResult({ ok: false, text: t('integ.frappe_crm_test_failed') });
        }
        setTesting(false);
    };
    return { testing, result, setResult, run };
}

const FrappeCrmIntegration = ({ hasFrappeCrmConfig, onSaved, last }: FrappeCrmIntegrationProps) => {
    const { t } = useTranslation();
    const [values, setValues] = useState<Values>(EMPTY);
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);
    const test = useConnectionTest(values);
    const set = (key: keyof Values) => (e: ChangeEvent<HTMLInputElement>) => setValues((v) => ({ ...v, [key]: e.target.value }));
    const reset = () => { setValues(EMPTY); test.setResult(null); };
    const complete = !!(values.url.trim() && values.apiKey.trim() && values.apiSecret.trim());
    const anyInput = Object.keys(bodyOf(values)).length > 0;
    const handleSave = () => {
        if (!anyInput) return;
        // A first connect needs all three, or the card would store a half connection.
        if (!hasFrappeCrmConfig && !complete) {
            setError(t('integ.frappe_crm_need_all'));
            return;
        }
        save(bodyOf(values), { onSuccess: reset });
    };
    const handleDisconnect = () => disconnect({ frappeCrmUrl: '', frappeCrmApiKey: '', frappeCrmApiSecret: '' }, { onSuccess: reset });
    const hint = (key: string) => (hasFrappeCrmConfig ? MASK : t(key));
    return (
        <IntegrationRow
            last={last}
            connected={hasFrappeCrmConfig}
            name="Frappe CRM"
            description={hasFrappeCrmConfig ? t('integ.frappe_crm_connected') : t('integ.frappe_crm_desc')}
            icon={<FrappeCrmLogo size={20} />}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.frappe_crm_step1')}</li>
                    <li>{t('integ.frappe_crm_step2')}</li>
                    <li>{t('integ.frappe_crm_step3')}</li>
                </ol>
                <input type="url" value={values.url} onChange={set('url')} autoComplete="off"
                    placeholder={hint('integ.frappe_crm_url_placeholder')}
                    aria-label={t('integ.frappe_crm_url_label')} className={FIELD} />
                <div className="flex gap-2">
                    <input type="text" value={values.apiKey} onChange={set('apiKey')} autoComplete="off"
                        placeholder={hint('integ.frappe_crm_key_placeholder')}
                        aria-label={t('integ.frappe_crm_key_label')} className={`flex-1 ${FIELD}`} />
                    <input type="password" value={values.apiSecret} onChange={set('apiSecret')}
                        autoComplete="off" data-1p-ignore data-lpignore="true"
                        placeholder={hint('integ.frappe_crm_secret_placeholder')}
                        aria-label={t('integ.frappe_crm_secret_label')} className={`flex-1 ${FIELD}`} />
                </div>
                <p className="text-[11px] text-[var(--text-muted)]">
                    {t('integ.frappe_crm_scope_note')} {t('integ.frappe_crm_help')}{' '}
                    <a href="https://docs.frappe.io/framework/user/en/guides/integration/rest_api/token_based_authentication" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('integ.frappe_crm_link')}</a>
                </p>
                <div className="flex gap-2">
                    <button type="button" onClick={test.run} disabled={test.testing || !(hasFrappeCrmConfig || complete)}
                        className={`${ACTION} [background:var(--bg-primary)] [color:var(--text-primary)]! [border:1px_solid_var(--border-default)]`}>
                        {test.testing ? '…' : t('integ.frappe_crm_test')}
                    </button>
                    <button type="button" onClick={handleSave} disabled={saving || !anyInput}
                        className={`${ACTION} text-white bg-[var(--accent-primary)]`}>
                        {saving ? '…' : t('settings.save', 'Save')}
                    </button>
                </div>
                {test.result && <p className={`text-[11px] ${test.result.ok ? '[color:#059669]!' : '[color:#dc2626]!'}`}>{test.result.text}</p>}
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasFrappeCrmConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

export default FrappeCrmIntegration;
