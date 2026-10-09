import React, { useCallback, useEffect, useState } from 'react';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { useTranslation } from '../../../../hooks/useTranslation';

const EU_HOST = 'eu.api.openai.com';

/**
 * Where OpenAI runs the inference.
 *
 * OpenAI's default domain processes prompts in the US; the regional endpoint
 * keeps them in the EU. It is off by default — it costs 10% more on models
 * released since March 2026, and switching it on is a decision an org makes
 * deliberately, not a default we pick for them.
 *
 * Deliberately worded as "processing in the EU", not as a privacy guarantee:
 * the setting changes WHERE inference happens, not WHAT gets sent. What leaves
 * the product is still the Privacy Shield's job.
 */
const EuResidencyToggle = ({ onMessage }) => {
    const { t } = useTranslation();
    const [provider, setProvider] = useState(null);
    const [saving, setSaving] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await authFetch(`${API_BASE}/ai/providers`);
            if (!res.ok) return;
            const data = await res.json();
            setProvider((data.providers || []).find(p => p.type === 'openai') || null);
        } catch (e) {
            // Non-fatal: the card still works as an API-key card without this.
        }
    }, []);

    useEffect(() => { load(); }, [load]);

    if (!provider) return null;

    const isEU = String(provider.url || '').includes(EU_HOST);

    const toggle = async () => {
        if (saving) return;
        setSaving(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/providers/${provider.id}/region`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region: isEU ? 'default' : 'eu' }),
            });
            if (res.ok) {
                const data = await res.json();
                setProvider(p => ({ ...p, url: data.url }));
                onMessage?.({
                    type: 'success',
                    text: data.region === 'eu'
                        ? t('admin_ai_config.openai_eu_on', 'OpenAI requests now run in the EU')
                        : t('admin_ai_config.openai_eu_off', 'OpenAI requests now use the default endpoint'),
                });
            } else {
                const err = await res.json().catch(() => ({}));
                onMessage?.({ type: 'error', text: err.error || t('admin_ai_config.openai_region_failed', 'Failed to change the processing region') });
            }
        } catch (e) {
            onMessage?.({ type: 'error', text: t('admin_ai_config.openai_region_failed', 'Failed to change the processing region') });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border-default)' }}>
            <div className="flex items-start gap-3 cursor-pointer" onClick={toggle} role="switch" aria-checked={isEU} tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                <div className={`w-9 h-5 rounded-full relative transition-colors shrink-0 mt-0.5 ${isEU ? 'bg-green-500' : 'bg-gray-600'} ${saving ? 'opacity-60' : ''}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEU ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <div>
                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                        {t('admin_ai_config.openai_eu_title', '🇪🇺 Process in the EU')}
                    </div>
                    <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {isEU
                            ? t('admin_ai_config.openai_eu_hint_on', 'Requests go to eu.api.openai.com: inference runs inside the EU. Models released since March 2026 cost 10% more on this endpoint.')
                            : t('admin_ai_config.openai_eu_hint_off', 'Requests go to the default endpoint, where inference runs in the US. Turn this on to keep processing inside the EU (10% surcharge on newer models).')}
                    </p>
                    <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                        {t('admin_ai_config.openai_eu_note', 'This changes where the model runs, not what is sent to it: the Privacy Shield still decides that.')}
                    </p>
                </div>
            </div>
        </div>
    );
};

const OpenAIApiKeyCard = ({ onMessage }) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.openai} onMessage={onMessage}>
        <EuResidencyToggle onMessage={onMessage} />
    </ProviderApiKeyCard>
);

export default OpenAIApiKeyCard;
