// The hosted reranker of the knowledge-base rerank chain (a Cohere rerank
// deployment on Azure AI Foundry): endpoint, key and deployment, a test call.
// A row of the Reranking group on Search & retrieval, after the provider tier.
import { useState } from 'react';
import type { ProviderPaneProps } from './providers/types';
import DeleteConfirmButtons from './ProviderCards/shared/DeleteConfirmButtons';
import SecretInput from './ProviderCards/shared/SecretInput';
import { Button } from '@/components/shared/Button';
import { CHIP, CHIP_SUCCESS } from '@/components/shared/adminUi';
import { FIELD_INPUT, SettingBlock } from '@/components/shared/SettingsList';
import useProviderConfig from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { apiFetch } from '@/api/typedRequest';

const DEFAULT_DEPLOYMENT = 'Cohere-rerank-v4.0-fast';
const MASK = '••••••••••••••••';

const hasChanges = (endpoint: string, apiKey: string, model: string, savedModel: string): boolean => !!endpoint.trim() || !!apiKey.trim() || model !== savedModel;

const RerankerConfig = ({ onMessage }: ProviderPaneProps) => {
    const { t } = useTranslation();
    const [endpoint, setEndpoint] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState(DEFAULT_DEPLOYMENT);
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
    const isConfigured = hasEndpoint && hasKey;

    const handleSave = async () => {
        if (!hasChanges(endpoint, apiKey, model, savedModel)) return;
        const body: Record<string, string> = {};
        if (endpoint.trim()) body.azureRerankerEndpoint = endpoint;
        if (apiKey.trim()) body.azureRerankerKey = apiKey;
        body.azureRerankerModel = model.trim() || DEFAULT_DEPLOYMENT;

        const ok = await save(body, { success: t('admin_ai_config.rerank_saved', 'Reranker config saved!'), error: t('admin_ai_config.rerank_save_failed', 'Failed to save reranker config') });
        if (ok) {
            patchConfig({
                ...(endpoint.trim() ? { hasAzureRerankerEndpoint: true } : {}),
                ...(apiKey.trim() ? { hasAzureRerankerKey: true } : {})
            });
            setSavedModel(model.trim() || DEFAULT_DEPLOYMENT);
            setEndpoint('');
            setApiKey('');
        }
    };

    const handleTest = async () => {
        setTesting(true);
        try {
            const res = await apiFetch('POST /ai/config/test-reranker', { init: { headers: { 'Content-Type': 'application/json' } } });
            const data = await res.json();
            if (res.ok && data.success) {
                onMessage?.({ type: 'success', text: t('admin_ai_config.rerank_working', 'Reranker working! Latency: {ms}ms', { ms: data.latencyMs }) });
            } else {
                onMessage?.({ type: 'error', text: data.error || t('admin_ai_config.rerank_test_failed', 'Reranker test failed') });
            }
        } catch (e) {
            onMessage?.({ type: 'error', text: t('admin_ai_config.rerank_test_failed_detail', 'Reranker test failed: {message}', { message: errorMessage(e) }) });
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

    return (
        <SettingBlock
            label={(
                <span className="flex items-center gap-2">
                    {t('ai_model_setup.rerank_azure_title', 'Azure AI Foundry reranker (Cohere)')}
                    <span className={isConfigured ? CHIP_SUCCESS : CHIP}>
                        {isConfigured ? t('admin_ai_config.status_connected', 'Connected') : t('admin_ai_config.status_not_connected', 'Not connected')}
                    </span>
                </span>
            )}
            hint={<>
                {t('admin_ai_config.rerank_deploy_from', 'Deploy from')}{' '}
                <a href="https://ai.azure.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--text-primary)]">Azure AI Foundry</a>{' '}
                {t('admin_ai_config.rerank_deploy_path', '→ Model catalog → Cohere-rerank')}
            </>}
        >
            <input
                type="text"
                value={endpoint}
                onChange={e => setEndpoint(e.target.value)}
                placeholder={hasEndpoint ? MASK : 'https://your-resource.services.ai.azure.com'}
                aria-label={t('ai_model_setup.rerank_azure_endpoint', 'Endpoint')}
                className={FIELD_INPUT}
            />
            <div className="flex flex-col gap-2 sm:flex-row">
                <SecretInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder={hasKey ? MASK : t('admin_ai_config.azure_key_placeholder', 'Azure API Key')}
                />
                <select
                    value={model}
                    onChange={e => setModel(e.target.value)}
                    className={`${FIELD_INPUT} sm:w-64`}
                    title={t('admin_ai_config.rerank_model_title', 'Reranker model deployment name')}
                    aria-label={t('admin_ai_config.rerank_model_title', 'Reranker model deployment name')}
                >
                    <option value="Cohere-rerank-v4.0-fast">Cohere-rerank-v4.0-fast</option>
                    <option value="Cohere-rerank-v4.0-pro">Cohere-rerank-v4.0-pro</option>
                </select>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
                {hasEndpoint && (
                    <DeleteConfirmButtons onConfirm={handleDeleteEndpoint} label={t('admin_ai_config.delete_endpoint', 'Endpoint')} title={t('admin_ai_config.remove_endpoint', 'Remove endpoint')} size="xs" />
                )}
                {hasKey && (
                    /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */
                    <DeleteConfirmButtons onConfirm={handleDeleteKey} label={t('admin_ai_config.delete_key', 'Key')} title={t('admin_ai_config.remove_api_key', 'Remove API key')} size="xs" />
                )}
                {isConfigured && (
                    <Button variant="secondary" size="sm" onClick={() => { void handleTest(); }} busy={testing}>
                        {t('admin_ai_config.rerank_test', 'Test')}
                    </Button>
                )}
                <Button size="sm" onClick={() => { void handleSave(); }} busy={saving} disabled={!hasChanges(endpoint, apiKey, model, savedModel)}>
                    {t('admin_ai_config.save', 'Save')}
                </Button>
            </div>
        </SettingBlock>
    );
};

export default RerankerConfig;
