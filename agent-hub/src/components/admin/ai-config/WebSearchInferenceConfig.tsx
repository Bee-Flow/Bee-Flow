import React, { useMemo, useState } from 'react';
import SectionHeader from '@/components/shared/SectionHeader';
import { OptionCard, SAVE_BUTTON, SettingBlock, SettingRow, SettingsList } from '@/components/shared/SettingsList';
import { useToastOnMessage } from './ui/useToastOnMessage';
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
        desc: t('admin_ai_config.ws_rr_cpu_desc', 'Runs a small bge-reranker-base model in this Node process via Transformers.js. ~280 MB RAM, no GPU, no API call. Best quality-per-resource for self-hosted setups.'),
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
    onNavigateToTab: (tab: string) => void;
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

const isChatModel = (m: InferenceModel): boolean => {
    const meta = getModelMeta(m.id);
    if (!meta) return true;
    return !['Embedding', 'OCR', 'Moderation', 'Audio'].includes(meta.cat);
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

const WebSearchInferenceConfig = ({ allModels = [], onNavigateToTab }: WebSearchInferenceConfigProps) => {
    const { t } = useTranslation();
    const RERANK_METHODS = getRerankMethods(t);
    const inference = useWebSearchInferenceQuery<InferenceConfig, EmbedSummary>();
    const stored = inference.data;
    const serverConfig = useMemo(() => stored?.config ?? DEFAULT_INFERENCE_CONFIG, [stored]);
    const { value: config, patch, discard } = useDraftOverServer(serverConfig);
    const setConfig: React.Dispatch<React.SetStateAction<InferenceConfig>> = (next) => patch(typeof next === 'function' ? next(config) : next);
    const embedSummary: EmbedSummary = stored?.embedSummary ?? NO_EMBED_SUMMARY;
    const loading = inference.isPending;
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);
    const { refetch: fetchAll } = inference;

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
                fetchAll().then(discard);
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
    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.loading_ellipsis', 'Loading…')}</div>;

    // Filter to chat-completion models only — same exclusions ChatModelTiersConfig uses.
    const chatModels = (allModels || []).filter(isChatModel);
    const cleanupGroups = groupByProvider(chatModels);

    // Embedding-only models — for the per-feature embed override.
    const embedModels = (allModels || []).filter((m: InferenceModel) => getModelMeta(m.id)?.cat === 'Embedding');
    const embedGroups = groupByProvider(embedModels);

    const cleanupLabel = modelLabel(findSelected(chatModels, config.cleanup), t('admin_ai_config.ws_cleanup_none', 'Disabled (no cleanup model selected)'));

    // Embed override — picker; empty falls back to global Embeddings config.
    const embedFallbackName = inheritedEmbedName(embedSummary);
    const inheritLabel = embedFallbackName
        ? t('admin_ai_config.ws_inherit_named', 'Inherit global · {name}', { name: embedFallbackName })
        : t('admin_ai_config.ws_inherit_none', 'Inherit global · (none configured)');
    const embedLabel = modelLabel(findSelected(embedModels, config.embed), inheritLabel);

    // Rerank model picker — only relevant when method='provider'.
    const rerankLabel = modelLabel(findSelected(chatModels, config.rerank), t('admin_ai_config.ws_pick_model', 'Pick a model'));

    return (
        <div className="flex max-w-4xl flex-col gap-6">
            <SectionHeader
                title={t('admin_ai_config.ws_title', 'Web Search: Inference')}
                description={t('admin_ai_config.ws_subtitle', 'Three tasks the search-service runs for every web query. Embeddings inherit your global Embeddings settings; rerank is a method-only choice; cleanup picks any chat model from a configured provider.')}
            />

            <WebSearchInferenceConfigSection t={t} onNavigateToTab={onNavigateToTab} config={config} embedLabel={embedLabel} embedGroups={embedGroups} setConfig={setConfig} RERANK_METHODS={RERANK_METHODS} rerankLabel={rerankLabel} cleanupGroups={cleanupGroups} cleanupLabel={cleanupLabel} />

            <div>
                <button type="button" onClick={handleSave} disabled={saving} className={SAVE_BUTTON}>
                    {saving ? t('admin_ai_config.saving_ellipsis', 'Saving…') : t('admin_ai_config.save', 'Save')}
                </button>
            </div>
        </div>
    );
};

export default WebSearchInferenceConfig;

function WebSearchInferenceConfigSection({ t, onNavigateToTab, config, embedLabel, embedGroups, setConfig, RERANK_METHODS, rerankLabel, cleanupGroups, cleanupLabel }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; onNavigateToTab: (tab: string) => void; config: { embed: { providerId: string; modelId: string; }; rerank: { method: string; providerId: string; modelId: string; }; cleanup: { providerId: string; modelId: string; }; }; embedLabel: string; embedGroups: Record<string, InferenceModel[]>; setConfig: React.Dispatch<React.SetStateAction<{ embed: { providerId: string; modelId: string; }; rerank: { method: string; providerId: string; modelId: string; }; cleanup: { providerId: string; modelId: string; }; }>>; RERANK_METHODS: { id: string; label: string; desc: string; }[]; rerankLabel: string; cleanupGroups: Record<string, InferenceModel[]>; cleanupLabel: string; }) {
    return <SettingsList>
        {/* Embeddings (per-feature picker; empty -> inherit global) */}
        <SettingRow
            label={t('admin_ai_config.ws_embeddings', 'Embeddings')}
            hint={(
                <>
                    {t('admin_ai_config.ws_embed_hint', 'Vectorise queries and pages for semantic search. Pick a model to override, or leave on “Inherit global” to use the model from the Embeddings tab.')}{' '}
                    {onNavigateToTab && (
                        <button type="button" onClick={() => onNavigateToTab('embeddings')} className="text-[var(--accent-primary)] underline-offset-2 hover:underline">
                            {t('admin_ai_config.ws_open_embed', 'Open Embeddings settings →')}
                        </button>
                    )}
                </>
            )}
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
                    {t('admin_ai_config.ws_embed_none', 'No embedding models found in your configured providers: add a provider with embeddings (e.g. OpenAI, Mistral) or set one globally in the Embeddings tab.')}
                </p>
            )}
        </SettingRow>

        {/* Reranking */}
        <SettingBlock
            label={t('admin_ai_config.ws_reranking', 'Reranking')}
            hint={t('admin_ai_config.ws_rerank_hint', 'Re-score search results to surface the most relevant. Provider-agnostic.')}
        >
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2 lg:grid-cols-4">
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
