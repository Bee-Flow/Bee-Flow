import React, { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiProvidersKey, useAiProvidersQuery } from '@/api/queries/adminConfigReads';
import ProviderApiKeyCard from './ProviderApiKeyCard';
import type { ProviderCardProps } from './ProviderApiKeyCard';
import { PROVIDER_KEY_CONFIGS } from './providerKeyConfig';
import { API_BASE } from '@/utils/helpers';
import { useTranslation } from '@/hooks/useTranslation';
import { RefusedError, mutate, errorBody } from '@/api/mutate';

const EU_HOST = 'eu.api.openai.com';

/** The openai row of GET /ai/providers. */
interface OpenAIProvider {
    id?: string | number;
    type?: string;
    url?: string;
}

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
const EuResidencyToggle = ({ onMessage }: ProviderCardProps) => {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const providers = useAiProvidersQuery<OpenAIProvider>().data;
    const provider = providers?.find(p => p.type === 'openai') || null;
    const [saving, setSaving] = useState(false);

    if (!provider) return null;

    const isEU = String(provider.url || '').includes(EU_HOST);

    const toggle = async () => {
        if (saving) return;
        setSaving(true);
        try {
            let res: Response | undefined;
            try {
                res = await mutate(`${API_BASE}/ai/providers/${provider.id}/region`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ region: isEU ? 'default' : 'eu' }),
            });
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                const err = errorBody(apiErr) ?? {};
                onMessage?.({ type: 'error', text: err.error || t('admin_ai_config.openai_region_failed', 'Failed to change the processing region') });
            }
            if (res) {
                const data = await res.json();
                queryClient.setQueryData<OpenAIProvider[] | null>(aiProvidersKey, (all) => (all || []).map(p => (p.id === provider.id ? { ...p, url: data.url } : p)));
                onMessage?.({
                    type: 'success',
                    text: data.region === 'eu'
                        ? t('admin_ai_config.openai_eu_on', 'OpenAI requests now run in the EU')
                        : t('admin_ai_config.openai_eu_off', 'OpenAI requests now use the default endpoint'),
                });
            }
        } catch (e) {
            onMessage?.({ type: 'error', text: t('admin_ai_config.openai_region_failed', 'Failed to change the processing region') });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="mt-4 pt-4 border-t border-[var(--border-default)]">
            <div className="flex items-start gap-3 cursor-pointer" onClick={toggle} role="switch" aria-checked={isEU} tabIndex={0}
                onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}>
                <div className={`w-9 h-5 rounded-full relative transition-colors shrink-0 mt-0.5 ${isEU ? 'bg-green-500' : 'bg-gray-600'} ${saving ? 'opacity-60' : ''}`}>
                    <div className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${isEU ? 'translate-x-4' : 'translate-x-0.5'}`} />
                </div>
                <div>
                    <div className="text-sm font-medium text-[var(--text-primary)]">
                        {t('admin_ai_config.openai_eu_title', '🇪🇺 Process in the EU')}
                    </div>
                    <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                        {isEU
                            ? t('admin_ai_config.openai_eu_hint_on', 'Requests go to eu.api.openai.com: inference runs inside the EU. Models released since March 2026 cost 10% more on this endpoint.')
                            : t('admin_ai_config.openai_eu_hint_off', 'Requests go to the default endpoint, where inference runs in the US. Turn this on to keep processing inside the EU (10% surcharge on newer models).')}
                    </p>
                    <p className="text-[11px] mt-1 text-[var(--text-muted)]">
                        {t('admin_ai_config.openai_eu_note', 'This changes where the model runs, not what is sent to it: the Privacy Shield still decides that.')}
                    </p>
                </div>
            </div>
        </div>
    );
};

const OpenAIApiKeyCard = ({ onMessage }: ProviderCardProps) => (
    <ProviderApiKeyCard provider={PROVIDER_KEY_CONFIGS.openai} onMessage={onMessage}>
        <EuResidencyToggle onMessage={onMessage} />
    </ProviderApiKeyCard>
);

export default OpenAIApiKeyCard;
