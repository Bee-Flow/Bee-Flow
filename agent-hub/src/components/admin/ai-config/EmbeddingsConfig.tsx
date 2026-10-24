import React, { useState, useEffect, useEffectEvent } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE } from '../../../utils/helpers';
import type { StatusMessage } from './chatModelTiers/tierTypes';
import { mutate, ApiError, request, RefusedError } from '../../../api/mutate';

interface EmbeddingProvider {
    id: string;
    name?: string;
    type?: string;
}

interface EmbeddingModel {
    id: string;
    name?: string;
    providerId?: string;
}

interface EmbeddingsConfigProps {
    providers: EmbeddingProvider[];
    allModels: EmbeddingModel[];
    fetchAllModels: () => void;
}

const EmbeddingsConfig = ({ providers, allModels, fetchAllModels }: EmbeddingsConfigProps) => {
    const { t } = useTranslation();
    const [config, setConfig] = useState({ embeddingProviderId: '', embeddingModel: '' });
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState<StatusMessage | null>(null);

    const refreshForProviders = useEffectEvent(() => {
        fetchConfig();
        // Ensure models are loaded
        if (allModels.length === 0 && providers.length > 0) {
            fetchAllModels();
        }
    });

    useEffect(() => {
        refreshForProviders();
    }, [providers]); // Refetch if providers change

    const fetchConfig = async () => {
        try {
            const res = await request(`${API_BASE}/ai/config`).catch((err: unknown) => {
                if (err instanceof RefusedError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                setConfig({
                    embeddingProviderId: data.embeddingProviderId || '',
                    embeddingModel: data.embeddingModel || ''
                });
            }
        } catch (e) {
            console.error('Failed to fetch config:', e);
        } finally {
            setLoading(false);
        }
    };

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

    // Azure embedding model is a deployment name and must be typed manually
    const selectedProvider = providers.find((p: EmbeddingProvider) => p.id === config.embeddingProviderId);
    const isAzure = selectedProvider?.type === 'azure';
    const useModelDropdown = providerModels.length > 0 && !isAzure;

    if (loading) return <div className="text-sm p-4 text-[var(--text-muted)]">{t('admin_ai_config.embed_loading', 'Loading settings...')}</div>;

    return (
        <div className="p-6 rounded-xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
            <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl [background:rgba(16,185,129,0.15)]">
                        🔍
                    </div>
                    <div>
                        <h3 className="text-lg font-semibold text-[var(--text-primary)]">{t('admin_ai_config.embed_title', 'Embedding Configuration')}</h3>
                        <p className="text-sm text-[var(--text-muted)]">{t('admin_ai_config.embed_subtitle', 'Configure vectors for Knowledge Base')}</p>
                    </div>
                </div>
                {message && (
                    <span className={`text-sm ${message.type === 'success' ? 'text-green-500' : 'text-red-500'}`}>
                        {message.text}
                    </span>
                )}
            </div>

            <div className="space-y-6 max-w-2xl">
                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_ai_config.embed_provider', 'Embedding Provider')}</label>
                    <select
                        value={config.embeddingProviderId}
                        onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setConfig({ ...config, embeddingProviderId: e.target.value, embeddingModel: '' })}
                        className="w-full px-4 py-2.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] [background:var(--bg-tertiary)] [border-color:var(--border-default)]! [color:var(--text-primary)]"
                    >
                        <option value="">{t('admin_ai_config.embed_select_provider', 'Select Provider...')}</option>
                        {providers.map((p: EmbeddingProvider) => (
                            <option key={p.id} value={p.id}>{p.name} ({p.type})</option>
                        ))}
                    </select>
                </div>

                <div>
                    <label className="block text-sm font-medium mb-2 text-[var(--text-primary)]">{t('admin_ai_config.embed_model', 'Embedding Model')}</label>
                    {useModelDropdown ? (
                        <select
                            value={config.embeddingModel}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setConfig({ ...config, embeddingModel: e.target.value })}
                            className="w-full px-4 py-2.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] [background:var(--bg-tertiary)] [border-color:var(--border-default)]! [color:var(--text-primary)]"
                        >
                            <option value="">{t('admin_ai_config.embed_select_model', 'Select Model...')}</option>
                            {providerModels.map((m: EmbeddingModel) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </select>
                    ) : (
                        <input
                            type="text"
                            value={config.embeddingModel}
                            onChange={(e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) => setConfig({ ...config, embeddingModel: e.target.value })}
                            placeholder={isAzure ? t('admin_ai_config.embed_azure_placeholder', 'Your Azure deployment name, e.g. text-embedding-3-small') : t('admin_ai_config.embed_model_placeholder', 'e.g. text-embedding-3-small')}
                            className="w-full px-4 py-2.5 rounded-lg border outline-none focus:border-[var(--accent-primary)] [background:var(--bg-tertiary)] [border-color:var(--border-default)]! [color:var(--text-primary)]"
                        />
                    )}
                    <p className="text-xs mt-1 text-[var(--text-muted)]">
                        {isAzure
                            ? t('admin_ai_config.embed_azure_hint', 'For Azure, enter the deployment name of your embedding model (not the base model name).')
                            : t('admin_ai_config.embed_mistral_hint', 'For Mistral, "mistral-embed" is recommended.')}
                    </p>
                </div>

                <div className="pt-4">
                    <button
                        onClick={handleSave}
                        disabled={saving}
                        className="px-6 py-2.5 rounded-xl font-medium text-white transition-all disabled:opacity-50 bg-[var(--accent-primary)]"
                    >
                        {saving ? t('admin_ai_config.saving', 'Saving...') : t('admin_ai_config.embed_save', 'Save Configuration')}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default EmbeddingsConfig;
