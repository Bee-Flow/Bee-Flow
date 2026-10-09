import React, { useState } from 'react';
import DeleteConfirmButtons from './ProviderCards/shared/DeleteConfirmButtons';
import SecretInput from './ProviderCards/shared/SecretInput';
import ProviderCardShell, { ProviderStatusPill, PROVIDER_INPUT_CLS, PROVIDER_INPUT_STYLE } from './ProviderCards/shared/ProviderCardShell';
import useProviderConfig from '../../../hooks/useProviderConfig';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';

const RerankerConfig = ({ onMessage }) => {
    const { t } = useTranslation();
    const [endpoint, setEndpoint] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState('Cohere-rerank-v4.0-fast');
    const [savedModel, setSavedModel] = useState('');
    const [testing, setTesting] = useState(false);

    const { config, saving, save, deleteKey, deleteSetting, patchConfig } = useProviderConfig({
        onMessage,
        onLoaded: data => {
            if (data.azureRerankerModel) {
                setSavedModel(data.azureRerankerModel);
                setModel(data.azureRerankerModel);
            }
        }
    });
    const hasEndpoint = !!config?.hasAzureRerankerEndpoint;
    const hasKey = !!config?.hasAzureRerankerKey;

    const handleSave = async () => {
        if (!endpoint.trim() && !apiKey.trim() && model === savedModel) return;
        const body = {};
        if (endpoint.trim()) body.azureRerankerEndpoint = endpoint;
        if (apiKey.trim()) body.azureRerankerKey = apiKey;
        body.azureRerankerModel = model.trim() || 'Cohere-rerank-v4.0-fast';

        const ok = await save(body, { success: t('admin_ai_config.rerank_saved', 'Reranker config saved!'), error: t('admin_ai_config.rerank_save_failed', 'Failed to save reranker config') });
        if (ok) {
            patchConfig({
                ...(endpoint.trim() ? { hasAzureRerankerEndpoint: true } : {}),
                ...(apiKey.trim() ? { hasAzureRerankerKey: true } : {})
            });
            setSavedModel(model.trim() || 'Cohere-rerank-v4.0-fast');
            setEndpoint('');
            setApiKey('');
        }
    };

    const handleTest = async () => {
        setTesting(true);
        try {
            const res = await authFetch(`${API_BASE}/ai/config/test-reranker`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (res.ok && data.success) {
                onMessage?.({ type: 'success', text: t('admin_ai_config.rerank_working', 'Reranker working! Latency: {ms}ms', { ms: data.latencyMs }) });
            } else {
                onMessage?.({ type: 'error', text: data.error || t('admin_ai_config.rerank_test_failed', 'Reranker test failed') });
            }
        } catch (e) {
            onMessage?.({ type: 'error', text: t('admin_ai_config.rerank_test_failed_detail', 'Reranker test failed: {message}', { message: e.message }) });
        } finally {
            setTesting(false);
        }
    };

    const handleDeleteKey = async () => {
        const ok = await deleteKey('azure_reranker_key', { success: t('admin_ai_config.rerank_key_removed', 'Reranker API key removed'), error: t('admin_ai_config.rerank_key_delete_failed', 'Failed to delete reranker API key') });
        if (ok) {
            patchConfig({ hasAzureRerankerKey: false });
            setApiKey('');
        }
    };

    const handleDeleteEndpoint = async () => {
        const ok = await deleteSetting('azure_reranker_endpoint', { success: t('admin_ai_config.rerank_endpoint_removed', 'Reranker endpoint removed'), error: t('admin_ai_config.rerank_endpoint_delete_failed', 'Failed to delete reranker endpoint') });
        if (ok) {
            patchConfig({ hasAzureRerankerEndpoint: false });
            setEndpoint('');
        }
    };

    const isConfigured = hasEndpoint && hasKey;

    return (
        <ProviderCardShell
            icon="🎯"
            iconGradient="linear-gradient(135deg, rgba(234,88,12,0.2), rgba(249,115,22,0.2))"
            title={t('admin_ai_config.rerank_title', 'Azure Cohere Reranker')}
            subtitle={isConfigured ? t('admin_ai_config.rerank_configured', '✅ Configured: Knowledge Base search results are reranked') : t('admin_ai_config.rerank_subtitle', 'Improve Knowledge Base search accuracy with neural reranking')}
            badges={<>
                {hasEndpoint && <ProviderStatusPill>{t('admin_ai_config.endpoint_pill', 'Endpoint')}</ProviderStatusPill>}
                {hasKey && <ProviderStatusPill>{t('admin_ai_config.key_pill', 'Key')}</ProviderStatusPill>}
                {savedModel && <ProviderStatusPill tone="orange">{savedModel}</ProviderStatusPill>}
            </>}
        >
            {/* Endpoint URL */}
            <div>
                <input
                    type="text"
                    value={endpoint}
                    onChange={e => setEndpoint(e.target.value)}
                    placeholder={hasEndpoint ? '••••••••••••••••' : 'https://your-resource.services.ai.azure.com'}
                    className={PROVIDER_INPUT_CLS}
                    style={PROVIDER_INPUT_STYLE}
                />
            </div>

            {/* API Key + Model row */}
            <div className="flex gap-2">
                <SecretInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder={hasKey ? '••••••••••••••••' : t('admin_ai_config.azure_key_placeholder', 'Azure API Key')}
                />
                <select
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className={`w-64 ${PROVIDER_INPUT_CLS.replace('w-full ', '')}`}
                    style={PROVIDER_INPUT_STYLE}
                    title={t('admin_ai_config.rerank_model_title', 'Reranker model deployment name')}
                >
                    <option value="Cohere-rerank-v4.0-fast">Cohere-rerank-v4.0-fast</option>
                    <option value="Cohere-rerank-v4.0-pro">Cohere-rerank-v4.0-pro</option>
                </select>
            </div>

            {/* Help + Actions */}
            <div className="flex items-center justify-between">
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('admin_ai_config.rerank_deploy_from', 'Deploy from')} <a href="https://ai.azure.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent-primary)]">Azure AI Foundry</a> {t('admin_ai_config.rerank_deploy_path', '→ Model catalog → Cohere-rerank')}
                </p>
                <div className="flex gap-2 items-center">
                    {hasEndpoint && (
                        <DeleteConfirmButtons onConfirm={handleDeleteEndpoint} label={t('admin_ai_config.delete_endpoint', '🗑️ Endpoint')} title={t('admin_ai_config.remove_endpoint', 'Remove endpoint')} size="xs" />
                    )}
                    {hasKey && (
                        <DeleteConfirmButtons onConfirm={handleDeleteKey} label={t('admin_ai_config.delete_key', '🗑️ Key')} title={t('admin_ai_config.remove_api_key', 'Remove API key')} size="xs" />
                    )}
                    {isConfigured && (
                        <button
                            onClick={handleTest}
                            disabled={testing}
                            className="px-3 py-2 rounded-lg text-xs font-medium transition-all hover:bg-white/10"
                            style={{ background: 'var(--bg-secondary)', color: 'var(--text-primary)' }}
                        >
                            {testing ? '...' : t('admin_ai_config.rerank_test', '🧪 Test')}
                        </button>
                    )}
                    <button
                        onClick={handleSave}
                        disabled={saving || (!endpoint.trim() && !apiKey.trim() && model === savedModel)}
                        className="px-5 py-2.5 rounded-lg font-medium text-white text-sm transition-all disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {saving ? '...' : t('admin_ai_config.save', 'Save')}
                    </button>
                </div>
            </div>
        </ProviderCardShell>
    );
};

export default RerankerConfig;
