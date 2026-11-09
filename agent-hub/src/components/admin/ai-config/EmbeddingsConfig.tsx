import React, { useState, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import SectionHeader from './SectionHeader';
import { FIELD_INPUT, SAVE_BUTTON, SettingRow, SettingsList } from './ui/SettingsList';
import { useToastOnMessage } from './ui/useToastOnMessage';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import { useTranslation } from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { mutate, ApiError } from '@/api/mutate';

interface EmbeddingProvider {
    id: string;
    name?: string;
    type?: string;
}

interface EmbeddingModel {
    id: string;
    name?: string;
    providerId?: string;
    embedding?: boolean;
}

interface EmbeddingsConfigProps {
    providers: EmbeddingProvider[];
    allModels: EmbeddingModel[];
    fetchAllModels: () => void;
}

const EmbeddingsConfig = ({ providers, allModels, fetchAllModels }: EmbeddingsConfigProps) => {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<{ embeddingProviderId?: string; embeddingModel?: string }>();
    const stored = aiConfig.data?.config;
    const serverForm = useMemo(() => ({ embeddingProviderId: stored?.embeddingProviderId || '', embeddingModel: stored?.embeddingModel || '' }), [stored]);
    const { value: config, patch: patchConfig } = useDraftOverServer(serverForm);
    const loading = aiConfig.isPending;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    // Ensure the models are loaded once there are providers to ask about.
    const loadModelsIfMissing = useEffectEvent(() => {
        if (allModels.length === 0 && providers.length > 0) fetchAllModels();
    });
    useEffect(() => {
        loadModelsIfMissing();
    }, [providers]);

    // Read the config again when the set of providers changes.
    const { refetch: refetchConfig } = aiConfig;
    const providersKey = providers.map(p => p.id).join(',');
    const providersSeen = useRef(providersKey);
    useEffect(() => {
        if (providersSeen.current === providersKey) return;
        providersSeen.current = providersKey;
        refetchConfig();
    }, [providersKey, refetchConfig]);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await mutate(`${API_BASE}/ai/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(config)
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                // A new model re-embeds the stored knowledge on the server
                // (core/kb/embeddingMigration.js); say so, since search is
                // keyword-only until it finishes.
                const body = await res.json().catch(() => ({}));
                setMessage(body?.reembedding
                    ? { type: 'success', text: t('admin.ai_embeddings_reembedding', 'Saved. Your knowledge bases are being re-indexed with the new model in the background; until that is done, search uses keywords only.') }
                    : { type: 'success', text: t('admin_ai_config.embed_saved', 'Embedding settings saved!') });
            } else {
                setMessage({ type: 'error', text: t('admin_ai_config.embed_save_failed', 'Failed to save settings') });
            }
        } catch (e) {
            setMessage({ type: 'error', text: t('admin_ai_config.embed_save_failed', 'Failed to save settings') });
        } finally {
            setSaving(false);
        }
    };

    // Filter models based on selected provider
    const providerModels = config.embeddingProviderId
        ? allModels.filter((m: EmbeddingModel) => m.providerId === config.embeddingProviderId)
        : [];
    // A provider that flags its embedding models (IONOS) lists only those, so a
    // chat or rerank model cannot be picked by mistake.
    // The saved model stays listed, so an earlier choice never shows as blank.
    const embeddingFlagged = providerModels.filter(
        (m: EmbeddingModel) => m.embedding === true || m.id === config.embeddingModel,
    );
    const modelChoices = embeddingFlagged.length > 0 ? embeddingFlagged : providerModels;

    // Azure embedding model is a deployment name and must be typed manually
    const selectedProvider = providers.find((p: EmbeddingProvider) => p.id === config.embeddingProviderId);
    const isAzure = selectedProvider?.type === 'azure';
    const useModelDropdown = providerModels.length > 0 && !isAzure;

    useToastOnMessage(message);
    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.embed_loading', 'Loading settings...')}</div>;

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('admin_ai_config.embed_title', 'Embedding Configuration')}
                description={t('admin_ai_config.embed_subtitle', 'Configure vectors for Knowledge Base')}
            />
            <SettingsList>
                <SettingRow htmlFor="embed-provider" label={t('admin_ai_config.embed_provider', 'Embedding Provider')}>
                    <select
                        id="embed-provider"
                        value={config.embeddingProviderId}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => patchConfig({ embeddingProviderId: e.target.value, embeddingModel: '' })}
                        className={FIELD_INPUT}
                    >
                        <option value="">{t('admin_ai_config.embed_select_provider', 'Select Provider...')}</option>
                        {providers.map((p: EmbeddingProvider) => (
                            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                        ))}
                    </select>
                </SettingRow>
                <SettingRow
                    htmlFor="embed-model"
                    label={t('admin_ai_config.embed_model', 'Embedding Model')}
                    hint={isAzure
                        ? t('admin_ai_config.embed_azure_hint', 'For Azure, enter the deployment name of your embedding model (not the base model name).')
                        : t('admin_ai_config.embed_mistral_hint', 'For Mistral, "mistral-embed" is recommended.')}
                >
                    {useModelDropdown ? (
                        <select
                            id="embed-model"
                            value={config.embeddingModel}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => patchConfig({ embeddingModel: e.target.value })}
                            className={FIELD_INPUT}
                        >
                            <option value="">{t('admin_ai_config.embed_select_model', 'Select Model...')}</option>
                            {modelChoices.map((m: EmbeddingModel) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            id="embed-model"
                            type="text"
                            value={config.embeddingModel}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => patchConfig({ embeddingModel: e.target.value })}
                            placeholder={isAzure ? t('admin_ai_config.embed_azure_placeholder', 'Your Azure deployment name, e.g. text-embedding-3-small') : t('admin_ai_config.embed_model_placeholder', 'e.g. text-embedding-3-small')}
                            className={FIELD_INPUT}
                        />
                    )}
                </SettingRow>
            </SettingsList>
            <div>
                <button type="button" onClick={handleSave} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.embed_save', 'Save Configuration')}
                </button>
            </div>
        </div>
    );
};

export default EmbeddingsConfig;
