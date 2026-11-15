import React, { useMemo, useState } from 'react';
import SaveFooter from '@/components/shared/SaveFooter';
import { OptionCard, SettingBlock, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import { canEmbed } from './embeddingProviders';
import { useToastOnMessage } from './ui/useToastOnMessage';
import { footerSaveState } from './ui/footerSaveState';
import { useWebSearchInferenceQuery } from '@/api/queries/adminConfigReads';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import { getModelMeta, getModelDisplayName, type ModelEntry } from '@/api/modelMeta';
import SearchableModelSelect from '../shared/SearchableModelSelect';
import { useTranslation, type TranslateParams } from '@/hooks/useTranslation';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { ApiError } from '@/api/mutate';
import { type ApiBody, apiRequest } from '@/api/typedRequest';

const getRerankMethods = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) => [
    {
        id: 'cosine',
        label: t('admin_ai_config.ws_rr_cosine', 'Cosine similarity'),
        desc: t('admin_ai_config.ws_rr_cosine_desc', 'Reuses the query and document embeddings: no extra model. Works with whichever provider you picked for embeddings.'),
    },
    {
        id: 'cpu',
        label: t('admin_ai_config.ws_rr_cpu', 'CPU cross-encoder'),
        desc: t('admin_ai_config.ws_rr_cpu_desc', 'Runs a small cross-encoder reranker on this server\'s CPU: about 280 MB of memory, no GPU, no API call. The best quality for the resources on a self-hosted setup.'),
    },
    {
        id: 'provider',
        label: t('admin_ai_config.ws_rr_provider', 'Provider model'),
        desc: t('admin_ai_config.ws_rr_provider_desc', 'Use a configured chat model (LLM-as-rerank) to score results. Pick any model from a configured provider below.'),
    },
    {
        id: 'local',
        label: t('admin_ai_config.ws_rr_local', 'Local cross-encoder (GPU)'),
        desc: t('admin_ai_config.ws_rr_local_desc', 'A vLLM-served reranker on your own GPU. Highest quality at the cost of dedicated hardware. Falls back to cosine when running cloud-only search.'),
    },
    {
        id: 'disabled',
        label: t('admin_ai_config.disabled', 'Disabled'),
        desc: t('admin_ai_config.ws_rr_disabled_desc', 'Skip the rerank step entirely. Results return in whatever order the vector store produced them.'),
    },
];

/** A model from one of the configured providers, as the AI config panel lists them. */
interface InferenceModel extends ModelEntry {
    providerId?: string;
    providerName?: string;
}

interface WebSearchInferenceConfigProps {
    allModels?: InferenceModel[];
}

type EmbedSummary = { providerId: string | null; providerName: string | null; modelId: string | null };
type InferenceConfig = {
    embed: { providerId: string; modelId: string };
    rerank: { method: string; providerId: string; modelId: string };
    cleanup: { providerId: string; modelId: string };
};
const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
    embed: { providerId: '', modelId: '' },
    rerank: { method: 'cosine', providerId: '', modelId: '' },
    cleanup: { providerId: '', modelId: '' },
};
const NO_EMBED_SUMMARY: EmbedSummary = { providerId: null, providerName: null, modelId: null };

/** A model that chats: the category the server stamped wins over the bundled table (as on the Models page). */
const isChatModel = (m: InferenceModel & { cat?: string }): boolean => {
    const cat = m.cat || getModelMeta(m.id)?.cat;
    return !cat || !['Embedding', 'OCR', 'Moderation', 'Audio', 'Rerank'].includes(cat);
};

function groupByProvider(models: InferenceModel[]): Record<string, InferenceModel[]> {
    const groups: Record<string, InferenceModel[]> = {};
    models.forEach((m: InferenceModel) => {
        const key = m.providerName || 'Unknown';
        if (!groups[key]) groups[key] = [];
        groups[key].push(m);
    });
    return groups;
}

const findSelected = (models: InferenceModel[], sel: { providerId: string; modelId: string }): InferenceModel | undefined =>
    models.find((m: InferenceModel) => m.id === sel.modelId && m.providerId === sel.providerId);

const modelLabel = (m: InferenceModel | undefined, fallback: string): string => (m ? `${getModelDisplayName(m)} · ${m.providerName}` : fallback);

function inheritedEmbedName(summary: EmbedSummary): string | null {
    if (!(summary.providerId && summary.modelId)) return null;
    return `${getModelMeta(summary.modelId)?.name || summary.modelId} · ${summary.providerName || summary.providerId}`;
}

const WebSearchInferenceConfig = ({ allModels = [] }: WebSearchInferenceConfigProps) => {
    const { t } = useTranslation();
    const RERANK_METHODS = getRerankMethods(t);
    const inference = useWebSearchInferenceQuery<InferenceConfig, EmbedSummary>();
    const stored = inference.data;
    const serverConfig = useMemo(() => stored?.config ?? DEFAULT_INFERENCE_CONFIG, [stored]);
    const { value: config, patch, discard } = useDraftOverServer(serverConfig);
    const dirty = JSON.stringify(config) !== JSON.stringify(serverConfig);
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const setConfig: React.Dispatch<React.SetStateAction<InferenceConfig>> = (next) => patch(typeof next === 'function' ? next(config) : next);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    const handleSave = async () => {
        setSaving(true);
        try {
            const res = await apiRequest('POST /ai/config/web-search-inference', {
                body: config as ApiBody<'POST /ai/config/web-search-inference'>, // rerank.method is one of RERANK_METHODS
            }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                setMessage({ type: 'success', text: t('admin_ai_config.limits_saved', 'Saved') });
                setLastSavedAt(new Date());
                inference.refetch().then(discard);
            } else {
                setMessage({ type: 'error', text: t('admin_ai_config.limits_save_failed', 'Failed to save') });
            }
        } catch (_) {
            setMessage({ type: 'error', text: t('admin_ai_config.limits_save_failed', 'Failed to save') });
        } finally {
            setSaving(false);
            setTimeout(() => setMessage(null), 2500);
        }
    };

    useToastOnMessage(message);
    if (inference.isPending) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('admin_ai_config.loading_ellipsis', 'Loading…')}</div>;

    // Filter to chat-completion models only — same exclusions ChatModelTiersConfig uses.
    const chatModels = (allModels || []).filter(isChatModel);
    const cleanupGroups = groupByProvider(chatModels);

    // Embedding-only models — for the per-feature embed override.
    const embedModels = (allModels || []).filter((m: InferenceModel) => canEmbed(m));
    const embedGroups = groupByProvider(embedModels);

    const cleanupLabel = modelLabel(findSelected(chatModels, config.cleanup), t('admin_ai_config.ws_cleanup_none', 'Disabled (no cleanup model selected)'));

    // Embed override — picker; empty falls back to global Embeddings config.
    const embedFallbackName = inheritedEmbedName(stored?.embedSummary ?? NO_EMBED_SUMMARY);
    const inheritLabel = embedFallbackName
        ? t('admin_ai_config.ws_inherit_named', 'Inherit global · {name}', { name: embedFallbackName })
        : t('admin_ai_config.ws_inherit_none', 'Inherit global · (none configured)');
    const embedLabel = modelLabel(findSelected(embedModels, config.embed), inheritLabel);

    // Rerank model picker — only relevant when method='provider'.
    const rerankLabel = modelLabel(findSelected(chatModels, config.rerank), t('admin_ai_config.ws_pick_model', 'Pick a model'));

    return (
        <SettingsGroup
            title={t('ai_model_setup.ws_group_title', 'Web search inference')}
            description={t('ai_model_setup.ws_group_hint', 'Three jobs the search runs for every web query: embeddings (the knowledge-base model unless you pick another), reranking and page cleanup.')}
        >
            <WebSearchInferenceConfigSection t={t} config={config} embedLabel={embedLabel} embedGroups={embedGroups} setConfig={setConfig} RERANK_METHODS={RERANK_METHODS} rerankLabel={rerankLabel} cleanupGroups={cleanupGroups} cleanupLabel={cleanupLabel} />

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

export default WebSearchInferenceConfig;

function WebSearchInferenceConfigSection({ t, config, embedLabel, embedGroups, setConfig, RERANK_METHODS, rerankLabel, cleanupGroups, cleanupLabel }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; config: { embed: { providerId: string; modelId: string; }; rerank: { method: string; providerId: string; modelId: string; }; cleanup: { providerId: string; modelId: string; }; }; embedLabel: string; embedGroups: Record<string, InferenceModel[]>; setConfig: React.Dispatch<React.SetStateAction<{ embed: { providerId: string; modelId: string; }; rerank: { method: string; providerId: string; modelId: string; }; cleanup: { providerId: string; modelId: string; }; }>>; RERANK_METHODS: { id: string; label: string; desc: string; }[]; rerankLabel: string; cleanupGroups: Record<string, InferenceModel[]>; cleanupLabel: string; }) {
    return <SettingsList>
        {/* Embeddings (per-feature picker; empty -> inherit global) */}
        <SettingRow
            label={t('admin_ai_config.ws_embeddings', 'Embeddings')}
            hint={t('ai_model_setup.ws_embed_hint', 'Vectorise queries and pages for semantic search. Pick a model to override, or leave on “Inherit global” to use the knowledge-base embedding model above.')}
        >
            <SearchableModelSelect
                value={config.embed}
                label={embedLabel}
                groups={embedGroups}
                title={t('admin_ai_config.ws_embed_select', 'Select embedding model')}
                clearLabel={t('admin_ai_config.ws_embed_clear', 'Inherit from global Embeddings settings')}
                onChange={({ providerId, modelId }) => setConfig(prev => ({ ...prev, embed: { providerId, modelId } }))} />
            {Object.keys(embedGroups).length === 0 && (
                <p className="m-0 mt-2 text-xs text-[var(--text-tertiary)]">
                    {t('ai_model_setup.ws_embed_none', 'No embedding models found in your configured providers: add a provider that offers embedding models under Providers, or keep the knowledge-base model above.')}
                </p>
            )}
        </SettingRow>

        {/* Reranking */}
        <SettingBlock
            label={t('admin_ai_config.ws_reranking', 'Reranking')}
            hint={t('admin_ai_config.ws_rerank_hint', 'Re-score search results to surface the most relevant. Provider-agnostic.')}
        >
            <div role="radiogroup" aria-label={t('admin_ai_config.ws_reranking', 'Reranking')} className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
                {RERANK_METHODS.map(opt => (
                    <OptionCard
                        key={opt.id}
                        selected={config.rerank.method === opt.id}
                        title={opt.label}
                        description={opt.desc}
                        onClick={() => setConfig(prev => ({
                            ...prev,
                            rerank: opt.id === 'provider'
                                ? { method: 'provider', providerId: prev.rerank.providerId, modelId: prev.rerank.modelId }
                                : { method: opt.id, providerId: '', modelId: '' },
                        }))}
                    />
                ))}
            </div>
            {config.rerank.method === 'provider' && (
                <div className="mt-1 max-w-sm">
                    <SearchableModelSelect
                        value={{ providerId: config.rerank.providerId, modelId: config.rerank.modelId }}
                        label={rerankLabel}
                        groups={cleanupGroups}
                        title={t('admin_ai_config.ws_rerank_select', 'Select rerank model')}
                        clearLabel={t('admin_ai_config.ws_rerank_clear', 'Pick a model (required for provider rerank)')}
                        onChange={({ providerId, modelId }) => setConfig(prev => ({ ...prev, rerank: { method: 'provider', providerId, modelId } }))} />
                    {!config.rerank.modelId && (
                        <p className="m-0 mt-1.5 text-xs text-[var(--text-tertiary)]">
                            {t('admin_ai_config.ws_rerank_pick_hint', 'Pick a model: without one, “Provider model” falls back to cosine similarity at runtime.')}
                        </p>
                    )}
                </div>
            )}
        </SettingBlock>

        {/* Cleanup */}
        <SettingRow
            label={t('admin_ai_config.ws_cleanup', 'Webpage cleanup')}
            hint={t('admin_ai_config.ws_cleanup_hint', 'Convert raw scraped HTML into clean, agent-readable text. Pick any chat model from a configured provider.')}
        >
            <SearchableModelSelect
                value={config.cleanup}
                label={cleanupLabel}
                groups={cleanupGroups}
                title={t('admin_ai_config.ws_cleanup_select', 'Select cleanup model')}
                clearLabel={t('admin_ai_config.ws_cleanup_clear', 'Disabled (skip cleanup)')}
                onChange={({ providerId, modelId }) => setConfig(prev => ({ ...prev, cleanup: { providerId, modelId } }))} />
            {Object.keys(cleanupGroups).length === 0 && (
                <p className="m-0 mt-2 text-xs text-[var(--text-tertiary)]">
                    {t('admin_ai_config.ws_no_providers', 'No providers configured yet: add an API key in the Providers tab to enable model selection.')}
                </p>
            )}
        </SettingRow>
    </SettingsList>;
}
