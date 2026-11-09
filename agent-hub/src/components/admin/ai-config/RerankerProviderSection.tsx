import React, { useMemo } from 'react';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import useProviderConfig from '@/hooks/useProviderConfig';
import type { ProviderMessage } from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { PROVIDER_INPUT_CLS, PROVIDER_INPUT_STYLE } from './ProviderCards/shared/ProviderCardShell';

export interface RerankProvider {
    id: string;
    name?: string;
    type?: string;
}

export interface RerankModel {
    id: string;
    name?: string;
    providerId?: string;
    rerank?: boolean;
}

interface RerankerProviderSectionProps {
    providers: RerankProvider[];
    allModels: RerankModel[];
    onMessage?: (message: ProviderMessage) => void;
}

interface RerankConfigRead {
    rerankProviderId?: string | null;
    rerankModel?: string | null;
}

interface RerankModelPickerProps {
    models: RerankModel[];
    value: string;
    onChange: (model: string) => void;
}

/** A dropdown of the provider's rerank models, or a free-text id when it flags none. */
const RerankModelPicker = ({ models, value, onChange }: RerankModelPickerProps) => {
    const { t } = useTranslation();
    const label = t('admin_ai_config.rerank_provider_model', 'Rerank model');
    if (models.length > 0) {
        return (
            <select value={value} onChange={e => onChange(e.target.value)} className={PROVIDER_INPUT_CLS} style={PROVIDER_INPUT_STYLE} aria-label={label}>
                <option value="">{t('admin_ai_config.rerank_provider_select_model', 'Select model...')}</option>
                {models.map(m => (
                    <option key={m.id} value={m.id}>{m.name || m.id}</option>
                ))}
            </select>
        );
    }
    return (
        <input
            type="text"
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder={t('admin_ai_config.rerank_provider_model_placeholder', 'Model id, e.g. Qwen/Qwen3-VL-Reranker-8B')}
            className={PROVIDER_INPUT_CLS}
            style={PROVIDER_INPUT_STYLE}
            aria-label={label}
        />
    );
};

/**
 * The provider tier of the Knowledge Base rerank chain: any provider that
 * serves an OpenAI/Cohere-style /rerank endpoint (IONOS, ...). Provider and
 * model are saved together; the tier is active only when both are set.
 */
const RerankerProviderSection = ({ providers, allModels, onMessage }: RerankerProviderSectionProps) => {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<RerankConfigRead>();
    const stored = aiConfig.data?.config;
    const serverForm = useMemo(() => ({ rerankProviderId: stored?.rerankProviderId || '', rerankModel: stored?.rerankModel || '' }), [stored]);
    const { value: form, patch, discard } = useDraftOverServer(serverForm);
    const { saving, save, patchConfig } = useProviderConfig({ onMessage });

    const providerModels = allModels.filter(m => m.providerId === form.rerankProviderId);
    const rerankModels = providerModels.filter(m => m.rerank === true);
    const isActive = !!stored?.rerankProviderId && !!stored?.rerankModel;
    const complete = !!form.rerankProviderId && !!form.rerankModel.trim();
    const dirty = form.rerankProviderId !== serverForm.rerankProviderId || form.rerankModel !== serverForm.rerankModel;

    const handleSave = async () => {
        const body = { rerankProviderId: form.rerankProviderId, rerankModel: form.rerankModel.trim() };
        const ok = await save(body, { success: t('admin_ai_config.rerank_provider_saved', 'Provider reranking saved!'), error: t('admin_ai_config.rerank_provider_save_failed', 'Failed to save provider reranking') });
        if (ok) patchConfig(body);
    };

    const handleClear = async () => {
        const body = { rerankProviderId: '', rerankModel: '' };
        const ok = await save(body, { success: t('admin_ai_config.rerank_provider_cleared', 'Provider reranking turned off'), error: t('admin_ai_config.rerank_provider_save_failed', 'Failed to save provider reranking') });
        if (ok) {
            patchConfig({ rerankProviderId: null, rerankModel: null });
            discard();
        }
    };

    return (
        <div className="space-y-2 pb-4 border-b border-[var(--border-default)]">
            <h4 className="text-sm font-medium text-[var(--text-primary)]">
                {t('admin_ai_config.rerank_provider_title', 'Provider (OpenAI/Cohere-style /rerank)')}
                {isActive && <span className="ml-2 text-xs text-green-500">{t('admin_ai_config.rerank_provider_active', 'Active')}</span>}
            </h4>
            <p className="text-xs text-[var(--text-muted)]">
                {t('admin_ai_config.rerank_provider_help', 'Rerank with a provider you connected above, for example IONOS with Qwen/Qwen3-VL-Reranker-8B. Order tried: local llama.cpp (if enabled), this provider, Azure Cohere, CPU, GPU sidecar, then plain rank fusion. The first one that is configured and answers wins.')}
            </p>
            <div className="flex gap-2">
                <select
                    value={form.rerankProviderId}
                    onChange={e => patch({ rerankProviderId: e.target.value, rerankModel: '' })}
                    className={`w-64 ${PROVIDER_INPUT_CLS.replace('w-full ', '')}`}
                    style={PROVIDER_INPUT_STYLE}
                    aria-label={t('admin_ai_config.rerank_provider_select', 'Rerank provider')}
                >
                    <option value="">{t('admin_ai_config.rerank_provider_none', 'No provider')}</option>
                    {providers.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                    ))}
                </select>
                <RerankModelPicker models={rerankModels} value={form.rerankModel} onChange={model => patch({ rerankModel: model })} />
            </div>
            <div className="flex gap-2 justify-end">
                {isActive && (
                    <button
                        onClick={handleClear}
                        disabled={saving}
                        className="px-3 py-2 rounded-lg text-xs font-medium transition-all hover:bg-white/10 [background:var(--bg-secondary)]! [color:var(--text-primary)]!"
                    >
                        {t('admin_ai_config.rerank_provider_turn_off', 'Turn off')}
                    </button>
                )}
                <button
                    onClick={handleSave}
                    disabled={saving || !complete || !dirty}
                    className="px-5 py-2.5 rounded-lg font-medium text-white text-sm transition-all disabled:opacity-50 bg-[var(--accent-primary)]"
                >
                    {saving ? '...' : t('admin_ai_config.save', 'Save')}
                </button>
            </div>
        </div>
    );
};

export default RerankerProviderSection;
