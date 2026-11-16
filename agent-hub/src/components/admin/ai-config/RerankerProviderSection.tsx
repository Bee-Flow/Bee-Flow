import { useMemo } from 'react';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import useProviderConfig from '@/hooks/useProviderConfig';
import type { ProviderMessage } from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/shared/Button';
import { CHIP_SUCCESS } from '@/components/shared/adminUi';
import { FIELD_INPUT, SettingBlock } from '@/components/shared/SettingsList';

interface RerankProvider {
    id: string;
    name?: string;
    type?: string;
}

interface RerankModel {
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
            <select value={value} onChange={e => onChange(e.target.value)} className={FIELD_INPUT} aria-label={label}>
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
            placeholder={t('ai_model_setup.rerank_model_placeholder', 'The rerank model id as your provider names it')}
            className={FIELD_INPUT}
            aria-label={label}
        />
    );
};

/**
 * The provider tier of the knowledge-base rerank chain: any connected provider
 * that serves a /rerank endpoint in the common format. Provider and model are
 * saved together; the tier is active only when both are set.
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
        <SettingBlock
            label={(
                <span className="flex items-center gap-2">
                    {t('admin_ai_config.rerank_provider_title', 'Reranking through a connected provider')}
                    {isActive && <span className={CHIP_SUCCESS}>{t('admin_ai_config.rerank_provider_active', 'Active')}</span>}
                </span>
            )}
            hint={t('admin_ai_config.rerank_provider_help', 'Rerank with a connected provider that serves a /rerank endpoint in the common format. Order tried: a local llama.cpp reranker (when enabled), this provider, the hosted reranker below, the CPU reranker, a GPU sidecar, then plain rank fusion. The first one that is set up and answers wins.')}
        >
            <div className="flex flex-col gap-2 sm:flex-row">
                <select
                    value={form.rerankProviderId}
                    onChange={e => patch({ rerankProviderId: e.target.value, rerankModel: '' })}
                    className={`${FIELD_INPUT} sm:w-64`}
                    aria-label={t('admin_ai_config.rerank_provider_select', 'Rerank provider')}
                >
                    <option value="">{t('admin_ai_config.rerank_provider_none', 'No provider')}</option>
                    {providers.map(p => (
                        <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                    ))}
                </select>
                <RerankModelPicker models={rerankModels} value={form.rerankModel} onChange={model => patch({ rerankModel: model })} />
            </div>
            <div className="flex justify-end gap-2">
                {isActive && (
                    <Button variant="secondary" size="sm" onClick={() => { void handleClear(); }} disabled={saving}>
                        {t('admin_ai_config.rerank_provider_turn_off', 'Turn off')}
                    </Button>
                )}
                <Button size="sm" onClick={() => { void handleSave(); }} busy={saving} disabled={!complete || !dirty}>
                    {t('admin_ai_config.save', 'Save')}
                </Button>
            </div>
        </SettingBlock>
    );
};

export default RerankerProviderSection;
