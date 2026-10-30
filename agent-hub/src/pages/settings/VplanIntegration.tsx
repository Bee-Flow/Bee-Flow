import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import useUserSettingSave from '../../hooks/useUserSettingSave';
import { IntegrationRow, ApiKeyField, DisconnectButton } from './IntegrationPrimitives';
import type { VplanIntegrationProps } from './IntegrationsSection.types';

// ── vPlan ─────────────────────────────────────────────────────────────────────
// Read-only planning access. vPlan issues an API key AND an API env together
// (Settings → Developers); both travel in request headers, so both are
// shape-checked server-side before they are stored.
const VplanIntegration = ({ hasVplanConfig, onSaved, last }: VplanIntegrationProps) => {
    const { t } = useTranslation();
    const [apiEnv, setApiEnv] = useState('');
    const [apiKey, setApiKey] = useState('');
    const { saving, disconnecting, error, setError, save, disconnect } = useUserSettingSave(onSaved);
    const clearFields = () => { setApiEnv(''); setApiKey(''); };
    const handleSave = () => {
        if (!apiEnv.trim() && !apiKey.trim()) return;
        // First connect needs both — a key-only save would store a half-configured
        // integration that still shows as disconnected.
        if (!hasVplanConfig && (!apiEnv.trim() || !apiKey.trim())) {
            setError(t('integ.vplan_need_both'));
            return;
        }
        const body: { vplanApiEnv?: string; vplanApiKey?: string } = {};
        if (apiEnv.trim()) body.vplanApiEnv = apiEnv.trim();
        if (apiKey.trim()) body.vplanApiKey = apiKey.trim();
        save(body, { onSuccess: clearFields });
    };
    const handleDisconnect = () => disconnect({ vplanApiKey: '', vplanApiEnv: '' }, { onSuccess: clearFields });
    return (
        <IntegrationRow
            last={last}
            connected={hasVplanConfig}
            name="vPlan"
            description={hasVplanConfig ? t('integ.vplan_connected') : t('integ.vplan_desc')}
            icon={<svg viewBox="0 0 24 24" fill="none" className="w-[20px] h-[20px]"><rect x="2" y="2" width="20" height="20" rx="4" fill="#1D4ED8" /><rect x="6" y="7" width="11" height="2.4" rx="1.2" fill="white" /><rect x="8.5" y="10.8" width="9.5" height="2.4" rx="1.2" fill="white" fillOpacity="0.85" /><rect x="6" y="14.6" width="7" height="2.4" rx="1.2" fill="white" fillOpacity="0.7" /></svg>}
        >
            <div className="space-y-2">
                <ol className="list-decimal pl-4 space-y-1 text-[11px] text-[var(--text-muted)]">
                    <li>{t('integ.vplan_step1')}</li>
                    <li>{t('integ.vplan_step2')}</li>
                    <li>{t('integ.vplan_step3')}</li>
                </ol>
                <input type="text" value={apiEnv} onChange={e => setApiEnv(e.target.value)}
                    placeholder={hasVplanConfig ? '••••••••' : t('integ.vplan_env_placeholder')}
                    aria-label={t('integ.vplan_env_label')}
                    className="w-full px-3 py-2 rounded-lg border outline-none text-[13px] focus:border-[var(--accent-primary)] transition-colors [background:var(--bg-primary)] [border-color:var(--border-default)]! [color:var(--text-primary)]!" />
                <ApiKeyField
                    placeholder={hasVplanConfig ? '••••••••••••••••' : t('integ.vplan_key_placeholder')}
                    value={apiKey} onChange={e => setApiKey(e.target.value)} onSave={handleSave} saving={saving}
                    canSave={!!(apiKey.trim() || apiEnv.trim())}
                    hint={<>{t('settings.integrations.vplan_help', 'vPlan Help:')} <a href="https://support.vplan.com/en/articles/158922-api" target="_blank" rel="noopener noreferrer" className="underline text-[var(--accent-primary)]">{t('settings.integrations.vplan_link', 'create an API key')}</a> {t('settings.integrations.vplan_plan', '(available from the Basic plan)')}</>}
                />
                {error && <p className="text-[11px] [color:#dc2626]!">{error}</p>}
                {hasVplanConfig && <DisconnectButton onDisconnect={handleDisconnect} disconnecting={disconnecting} />}
            </div>
        </IntegrationRow>
    );
};

export default VplanIntegration;
