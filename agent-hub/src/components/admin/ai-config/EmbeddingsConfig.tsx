import React, { useState, useEffect, useEffectEvent, useMemo, useRef } from 'react';
import SaveFooter from '@/components/shared/SaveFooter';
import { FIELD_INPUT, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from './ui/useToastOnMessage';
import { footerSaveState } from './ui/footerSaveState';
import { useAiConfigQuery } from '@/api/queries/aiConfigRead';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { ApiError } from '@/api/mutate';
import { expectedEmbeddingDims, exceedsVectorIndex, type EmbeddingModelShape } from './embeddingOutputDims';
import { apiRequest } from '@/api/typedRequest';
import { embeddingModelChoices, embeddingProviders } from './embeddingProviders';

interface EmbeddingProvider {
    id: string;
    name?: string;
    type?: string;
}

interface EmbeddingModel extends EmbeddingModelShape {
    id: string;
    name?: string;
    providerId?: string;
    embedding?: boolean;
    cat?: string;
}

interface EmbeddingChoice {
    embeddingProviderId?: string;
    embeddingModel?: string;
    embeddingDimensions?: number | null;
}

/**
 * Vectors above the HNSW limit make every knowledge-base search a full scan:
 * say so under the model picker. The saved model keeps the length the server
 * reports; a new choice gets what the server will decide for it.
 */
function IndexLimitWarning({ models, choice, saved }: { models: EmbeddingModel[]; choice: EmbeddingChoice; saved: EmbeddingChoice | null | undefined }) {
    const { t } = useTranslation();
    const model = models.find((m: EmbeddingModel) => m.id === choice.embeddingModel);
    const isSaved = choice.embeddingProviderId === (saved?.embeddingProviderId || '') && choice.embeddingModel === (saved?.embeddingModel || '');
    const dims = expectedEmbeddingDims(model, isSaved ? (saved?.embeddingDimensions ?? null) : undefined);
    if (!exceedsVectorIndex(dims)) return null;
    return (
        <p role="status" className="m-0 mt-2 text-xs text-[var(--warning-ink)]">
            {t('admin_ai_config.embed_dims_no_index', 'This model returns vectors of {dims} dimensions, more than the 2000 the fast vector index takes. Searches on this model cannot use the fast index, so knowledge-base search gets slower as your knowledge bases grow.', { dims })}
        </p>
    );
}

/** The hint under the model field, for the selected provider's type only. */
function modelHint(t: TranslateFn, providerType: string | undefined): string {
    if (providerType === 'azure') return t('admin_ai_config.embed_azure_hint', 'For Azure, enter the deployment name of your embedding model (not the base model name).');
    if (providerType === 'mistral') return t('admin_ai_config.embed_mistral_hint', 'For Mistral, "mistral-embed" is recommended.');
    return t('ai_model_setup.embed_model_hint', 'Pick an embedding model this provider offers. Changing it later re-indexes your knowledge bases.');
}

interface ProviderSelectProps {
    providers: EmbeddingProvider[];
    allModels: EmbeddingModel[];
    value: string;
    savedId: string;
    onChange: (providerId: string) => void;
}

/** Only providers that can embed (embeddingProviders); the saved and the selected one stay listed. */
function ProviderSelect({ providers, allModels, value, savedId, onChange }: ProviderSelectProps) {
    const { t } = useTranslation();
    const choices = embeddingProviders(providers, allModels, [savedId, value]);
    return (
        <SettingRow htmlFor="embed-provider" label={t('admin_ai_config.embed_provider', 'Embedding Provider')}>
            <select
                id="embed-provider"
                value={value}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onChange(e.target.value)}
                className={FIELD_INPUT}
            >
                <option value="">{t('admin_ai_config.embed_select_provider', 'Select Provider...')}</option>
                {choices.map((p: EmbeddingProvider) => (
                    <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                ))}
            </select>
            {choices.length === 0 && providers.length > 0 && (
                <p role="note" className="m-0 mt-2 text-xs text-[var(--text-tertiary)]">
                    {t('ai_model_setup.embed_no_providers', 'No connected provider offers embedding models. Connect one under Providers.')}
                </p>
            )}
        </SettingRow>
    );
}

interface EmbeddingsConfigProps {
    providers: EmbeddingProvider[];
    allModels: EmbeddingModel[];
    fetchAllModels: () => void;
}

const EmbeddingsConfig = ({ providers, allModels, fetchAllModels }: EmbeddingsConfigProps) => {
    const { t } = useTranslation();
    const aiConfig = useAiConfigQuery<EmbeddingChoice>();
    const stored = aiConfig.data?.config;
    const serverForm = useMemo(() => ({ embeddingProviderId: stored?.embeddingProviderId || '', embeddingModel: stored?.embeddingModel || '' }), [stored]);
    const { value: config, patch: patchConfig, discard } = useDraftOverServer(serverForm);
    const dirty = config.embeddingProviderId !== serverForm.embeddingProviderId || config.embeddingModel !== serverForm.embeddingModel;
    const loading = aiConfig.isPending;
    const [saving, setSaving] = useState(false);
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
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
            const res = await apiRequest('POST /ai/config', { body: config }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setLastSavedAt(new Date());
                void refetchConfig().then(discard);
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
    const modelChoices = embeddingModelChoices(providerModels, config.embeddingModel);

    // Azure embedding model is a deployment name and must be typed manually
    const providerType = providers.find((p: EmbeddingProvider) => p.id === config.embeddingProviderId)?.type;
    const isAzure = providerType === 'azure';
    const useModelDropdown = providerModels.length > 0 && !isAzure;

    useToastOnMessage(message);
    if (loading) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('admin_ai_config.embed_loading', 'Loading settings...')}</div>;

    return (
        <SettingsGroup
            title={t('ai_model_setup.embed_group_title', 'Embedding model')}
            description={t('ai_model_setup.embed_group_hint', 'Turns knowledge-base text into vectors for semantic search. Changing it re-indexes your knowledge bases.')}
        >
            <SettingsList>
                <ProviderSelect
                    providers={providers}
                    allModels={allModels}
                    value={config.embeddingProviderId}
                    savedId={stored?.embeddingProviderId || ''}
                    onChange={(id) => patchConfig({ embeddingProviderId: id, embeddingModel: '' })}
                />
                <SettingRow
                    htmlFor="embed-model"
                    label={t('admin_ai_config.embed_model', 'Embedding Model')}
                    hint={modelHint(t, providerType)}
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
                            placeholder={isAzure ? t('admin_ai_config.embed_azure_placeholder', 'Your Azure deployment name, e.g. text-embedding-3-small') : t('admin_ai_config.embed_model_placeholder', 'The model id as your provider names it')}
                            className={FIELD_INPUT}
                        />
                    )}
                    <IndexLimitWarning models={providerModels} choice={config} saved={stored} />
                </SettingRow>
            </SettingsList>
            <SaveFooter
                onSave={() => { void handleSave(); }}
                onCancel={dirty ? discard : undefined}
                saving={saving}
                dirty={dirty}
                saveState={footerSaveState(saving, message, lastSavedAt)}
                lastSavedAt={lastSavedAt}
            />
        </SettingsGroup>
    );
};

export default EmbeddingsConfig;
