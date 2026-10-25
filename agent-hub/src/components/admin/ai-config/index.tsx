import { useState, useEffect, useEffectEvent, SetStateAction, Dispatch } from 'react';
import DirectChatConfig from './DirectChatConfig';
import EmbeddingsConfig from './EmbeddingsConfig';
import LimitsConfig from './LimitsConfig';
import ChatModelTiersConfig from './ChatModelTiersConfig';
import AzureConfigCard from './ProviderCards/AzureCard';
import ClaudeApiKeyCard from './ProviderCards/ClaudeCard';
import EuGptApiKeyCard from './ProviderCards/EuGptCard';
import GoogleApiKeyCard from './ProviderCards/GoogleCard';
import MistralApiKeyCard from './ProviderCards/MistralCard';
import ScalewayApiKeyCard from './ProviderCards/ScalewayCard';
import { TranslateParams, useTranslation } from '../../../hooks/useTranslation';
import { API_BASE } from '../../../utils/helpers';
import { getModelMeta, CAT_COLORS } from '../../../api/modelMeta';

import WebSearchInferenceConfig from './WebSearchInferenceConfig';

import OpenAIApiKeyCard from './ProviderCards/OpenAICard';
import ElevenLabsApiKeyCard from './ProviderCards/ElevenLabsCard';
import GoogleVertexConfigCard from './ProviderCards/GoogleVertexCard';
import LocalModelsCard from './ProviderCards/LocalModelsCard';
import RerankerConfig from './RerankerConfig';
import type { ProviderMessage } from '../../../hooks/useProviderConfig';
import type { CatalogModel } from './chatModelTiers/tierTypes';
import { request, RefusedError } from '../../../api/mutate';

/** A provider as GET /ai/providers lists it. */
interface ProviderRow {
    id: string;
    name?: string;
    type?: string;
}

/** A provider's model, stamped with the provider it came from. */
interface ModelRow extends CatalogModel {
    name?: string;
    providerId: string;
    providerType?: string;
}


const AIConfigPanel = () => {
    const { t } = useTranslation();
    // Navigation State
    const [activeTab, setActiveTab] = useState('providers');

    // Providers State
    const [providers, setProviders] = useState<ProviderRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [message, setMessage] = useState<ProviderMessage | null>(null);

    // Models State
    const [allModels, setAllModels] = useState<ModelRow[]>([]);
    const [loadingModels, setLoadingModels] = useState(false);
    const [expandedProviderModels, setExpandedProviderModels] = useState<Record<string, boolean>>({});

    useEffect(() => {
        fetchProviders();
    }, []);

    const loadModelsForTab = useEffectEvent(() => {
        if (providers.length > 0 && (activeTab === 'providers' || activeTab === 'chatModels' || activeTab === 'webSearchInference' || activeTab === 'embeddings')) {
            fetchAllModels();
        }
    });

    useEffect(() => {
        loadModelsForTab();
    }, [activeTab, providers]);

    const fetchProviders = async () => {
        try {
            const res = await request(`${API_BASE}/ai/providers`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setProviders(data.providers || []);
            }
        } catch (e) {
            console.error('Failed to fetch providers:', e);
        } finally {
            setLoading(false);
        }
    };

    const fetchAllModels = async () => {
        setLoadingModels(true);
        try {
            const results = await Promise.all(
                providers.map(async (provider) => {
                    try {
                        const res = await request(`${API_BASE}/ai/providers/${provider.id}/models`).catch((err: unknown) => {
                            if (err instanceof RefusedError) return null;
                            throw err;
                        });
                        if (res) {
                            const data = await res.json();
                            return (data.models || []).map((m: CatalogModel) => ({
                                ...m,
                                providerId: provider.id,
                                providerName: provider.name,
                                providerType: provider.type
                            }));
                        }
                        return [];
                    } catch (e) {
                        console.error(`Failed to fetch models for ${provider.name}:`, e);
                        return [];
                    }
                })
            );
            setAllModels(results.flat());
        } catch (e) {
            console.error('Failed to fetch models:', e);
        }
        setLoadingModels(false);
    };

    const toggleProviderModels = (providerName: string) => {
        setExpandedProviderModels(prev => ({
            ...prev,
            [providerName]: !prev[providerName]
        }));
    };

    const getProviderModelCount = (providerName: string) => {
        return allModels.filter(m => m.providerName === providerName).length;
    };

    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.index_loading_providers', 'Loading providers...')}</div>;

    const navItems = [
        { id: 'providers', label: t('admin.ai_api_keys'), icon: '🔑' },
        { id: 'chatModels', label: t('admin.ai_chat_models'), icon: '🗨️' },
        { id: 'embeddings', label: t('admin.ai_embeddings', 'Embeddings'), icon: '🧬' },
        { id: 'directChat', label: t('admin.ai_direct_chat'), icon: '💬' },
        { id: 'webSearchInference', label: t('admin.ai_web_search_inference', 'Web Search Inference'), icon: '🌐' },
        { id: 'limits', label: t('admin.ai_limits', 'Limits & Self-host'), icon: '⚙️' },

    ];

    // Provider cards config — maps provider name to its card component
    const providerCards = [
        { name: 'Mistral', component: MistralApiKeyCard },
        { name: 'OpenAI', component: OpenAIApiKeyCard },
        { name: 'Claude', component: ClaudeApiKeyCard },
        { name: 'Google AI', component: GoogleApiKeyCard },
        { name: 'Scaleway', component: ScalewayApiKeyCard },
        { name: 'EU GPT', component: EuGptApiKeyCard },
        { name: 'ElevenLabs', component: ElevenLabsApiKeyCard },
        { name: 'Google Vertex', component: GoogleVertexConfigCard },
        { name: 'Azure', component: AzureConfigCard },
    ];

    return (
        <div className="flex h-full border rounded-xl overflow-hidden shadow-sm border-[var(--border-default)] bg-[var(--bg-secondary)]">
            {/* Left Sidebar */}
            <AIConfigPanelSection t={t} navItems={navItems} setActiveTab={setActiveTab} activeTab={activeTab} />

            {/* Content Area */}
            <div className="flex-1 overflow-y-auto p-8 bg-[var(--bg-primary)]">
                {message && (
                    <div className={`p-3 rounded-lg text-sm mb-4 ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
                        {message.text}
                    </div>
                )}

                {/* Providers Tab — API Keys + inline model lists */}
                {activeTab === 'providers' && (
                    <div className="space-y-0">
                        {providerCards.map(({ name, component: Card }) => {
                            const modelCount = getProviderModelCount(name);
                            const isExpanded = expandedProviderModels[name];
                            const providerModels = allModels.filter(m => m.providerName === name);

                            return (
                                <div key={name}>
                                    <Card onMessage={setMessage} />
                                    {/* Inline model list (collapsible) */}
                                    {modelCount > 0 && (
                                        <div className="-mt-3 mb-6 mx-0">
                                            <button
                                                onClick={() => toggleProviderModels(name)}
                                                className="flex items-center gap-2 text-xs px-5 py-1.5 rounded-b-lg transition-colors hover:bg-white/5 w-full text-left text-[var(--text-muted)]"
                                            >
                                                <svg className={`w-3 h-3 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                                                </svg>
                                                <span>{modelCount === 1 ? t('admin_ai_config.index_models_one', '1 available model') : t('admin_ai_config.index_models_other', '{count} available models', { count: modelCount })}</span>
                                            </button>
                                            {isExpanded && (
                                                <div className="px-5 pb-3 pt-1">
                                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-1.5">
                                                        {providerModels.map(model => {
                                                            const meta = getModelMeta(model.id);
                                                            return (
                                                                <div
                                                                    key={model.id}
                                                                    className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs bg-[var(--bg-tertiary)]"
                                                                >
                                                                    <span className="font-medium truncate flex-1 text-[var(--text-primary)]">
                                                                        {meta?.name || model.name || model.id}
                                                                    </span>
                                                                    {meta?.cat && (
                                                                        <span className="text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap" style={{
                                                                            background: CAT_COLORS[meta.cat] || 'rgba(107,114,128,0.2)',
                                                                            color: 'var(--text-muted)'
                                                                        }}>
                                                                            {meta.cat}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            );
                        })}

                        {/* Self-hosted runtimes. Not part of providerCards
                            above: those are one-API-key singletons matched by a
                            fixed display name, while a customer can connect
                            several local runtimes under names they choose. */}
                        {/* onProvidersChanged → fetchProviders always sets a fresh
                            array, so the [activeTab, providers] effect re-runs
                            fetchAllModels and a newly connected runtime (or a
                            newly pulled model) shows up in the tier picker. */}
                        <LocalModelsCard onMessage={setMessage} onProvidersChanged={fetchProviders} />

                        {/* Reranker stays at the bottom of providers */}
                        <RerankerConfig onMessage={setMessage} />

                        {/* Models loading indicator */}
                        {loadingModels && (
                            <p className="text-xs text-center py-2 text-[var(--text-muted)]">
                                {t('admin_ai_config.index_loading_models', 'Loading available models...')}
                            </p>
                        )}
                    </div>
                )}

                {/* Chat Models Tab — Tier Assignment */}
                {activeTab === 'chatModels' && (
                    <ChatModelTiersConfig allModels={allModels} />
                )}

                {/* Embeddings Tab — global embedding provider + model picker */}
                {activeTab === 'embeddings' && (
                    <EmbeddingsConfig providers={providers} allModels={allModels} fetchAllModels={fetchAllModels} />
                )}

                {/* Direct Chat Tab — System Prompt only */}
                {activeTab === 'directChat' && (
                    <DirectChatConfig />
                )}

                {/* Web Search Inference Tab — embed inherits global, rerank method-only, cleanup uses chat-model picker */}
                {activeTab === 'webSearchInference' && (
                    <WebSearchInferenceConfig allModels={allModels} onNavigateToTab={setActiveTab} />
                )}

                {/* Limits Tab — runtime caps applied to chat surfaces */}
                {activeTab === 'limits' && (
                    <LimitsConfig onNavigateToTab={setActiveTab} />
                )}

            </div>
        </div >
    );
};

export default AIConfigPanel;

function AIConfigPanelSection({ t, navItems, setActiveTab, activeTab }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; navItems: { id: string; label: string; icon: string; }[]; setActiveTab: Dispatch<SetStateAction<string>>; activeTab: string; }) {
    return <div className="w-64 flex flex-col p-2 border-r border-[var(--border-default)] bg-[var(--bg-secondary)]">
        <div className="p-4 mb-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{t('admin_ai_config.index_title', 'AI Configuration')}</h3>
        </div>
        <div className="space-y-1">
            {navItems.map(item => (
                <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`w-full flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all text-left ${activeTab === item.id
                        ? 'bg-[var(--accent-primary)] text-white shadow-md'
                        : 'text-[var(--text-secondary)] hover:bg-white/5 hover:text-[var(--text-primary)]'}`}
                >
                    <span className="text-lg">{item.icon}</span>
                    {item.label}
                </button>
            ))}
        </div>
    </div>;
}
