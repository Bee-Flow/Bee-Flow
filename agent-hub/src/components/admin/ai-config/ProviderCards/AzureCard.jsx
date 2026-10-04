import React, { useState } from 'react';
import DeleteConfirmButtons from './shared/DeleteConfirmButtons';
import SecretInput from './shared/SecretInput';
import ProviderCardShell, { ProviderStatusPill, PROVIDER_INPUT_CLS, PROVIDER_INPUT_STYLE } from './shared/ProviderCardShell';
import useProviderConfig from '../../../../hooks/useProviderConfig';

const AzureConfigCard = ({ onMessage }) => {
    const [endpoint, setEndpoint] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [models, setModels] = useState('');
    const [savedModels, setSavedModels] = useState('');

    const { config, saving, save, deleteKey, deleteSetting, patchConfig } = useProviderConfig({
        onMessage,
        onLoaded: data => {
            if (data.azureModels) {
                setSavedModels(data.azureModels);
                setModels(data.azureModels);
            }
        }
    });
    const hasEndpoint = !!config?.hasAzureEndpoint;
    const hasKey = !!config?.hasAzureApiKey;

    const handleSave = async () => {
        if (!endpoint.trim() && !apiKey.trim() && !models.trim()) return;
        const body = {};
        if (endpoint.trim()) body.azureEndpoint = endpoint;
        if (apiKey.trim()) body.azureApiKey = apiKey;
        body.azureModels = models.trim();

        const ok = await save(body, { success: 'Azure AI config saved!', error: 'Failed to save config' });
        if (ok) {
            patchConfig({
                ...(endpoint.trim() ? { hasAzureEndpoint: true } : {}),
                ...(apiKey.trim() ? { hasAzureApiKey: true } : {})
            });
            setSavedModels(models.trim());
            setEndpoint('');
            setApiKey('');
        }
    };

    const handleDeleteKey = async () => {
        const ok = await deleteKey('azure_api_key', { success: 'Azure API key removed', error: 'Failed to delete Azure API key' });
        if (ok) {
            patchConfig({ hasAzureApiKey: false });
            setApiKey('');
        }
    };

    const handleDeleteEndpoint = async () => {
        const ok = await deleteSetting('azure_endpoint', { success: 'Azure endpoint removed', error: 'Failed to delete Azure endpoint' });
        if (ok) {
            patchConfig({ hasAzureEndpoint: false });
            setEndpoint('');
        }
    };

    const isConfigured = hasEndpoint && hasKey;
    const modelCount = savedModels ? savedModels.split(',').filter(m => m.trim()).length : 0;

    return (
        <ProviderCardShell
            icon="🔷"
            iconGradient="linear-gradient(135deg, rgba(0,120,212,0.2), rgba(0,153,255,0.2))"
            title="Azure AI"
            subtitle={isConfigured ? '✅ Fully configured' : 'Azure OpenAI Service'}
            badges={<>
                {hasEndpoint && <ProviderStatusPill>Endpoint</ProviderStatusPill>}
                {hasKey && <ProviderStatusPill>Key</ProviderStatusPill>}
                {modelCount > 0 && <ProviderStatusPill tone="blue">{modelCount} model{modelCount !== 1 ? 's' : ''}</ProviderStatusPill>}
            </>}
        >
            {/* Endpoint URL */}
            <div>
                <input
                    type="text"
                    value={endpoint}
                    onChange={e => setEndpoint(e.target.value)}
                    placeholder={hasEndpoint ? '••••••••••••••••' : 'https://your-resource.openai.azure.com'}
                    className={PROVIDER_INPUT_CLS}
                    style={PROVIDER_INPUT_STYLE}
                />
            </div>

            {/* API Key. No API version: Bee Flow always uses Azure's v1 GA API. */}
            <div className="flex gap-2">
                <SecretInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder={hasKey ? '••••••••••••••••' : 'Azure API Key'}
                />
            </div>

            {/* Models input */}
            <div>
                <input
                    type="text"
                    value={models}
                    onChange={e => setModels(e.target.value)}
                    placeholder="Deployment names, e.g. gpt-5.6-terra, prod-chat=gpt-6-astra, gpt-4.1"
                    className={PROVIDER_INPUT_CLS}
                    style={PROVIDER_INPUT_STYLE}
                    title="Comma-separated list of your Azure deployment names"
                />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    Comma-separated deployment names from your Azure portal. If a deployment is not named
                    after its model, write name=model (prod-chat=gpt-6-astra).
                </p>
            </div>

            {/* Help + Save */}
            <div className="flex items-center justify-between">
                <div className="flex gap-2 flex-wrap">
                    <p className="text-xs self-center" style={{ color: 'var(--text-muted)' }}>
                        Get from <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent-primary)]">portal.azure.com</a>
                    </p>
                </div>
                <div className="flex gap-2 items-center">
                    {hasEndpoint && (
                        <DeleteConfirmButtons onConfirm={handleDeleteEndpoint} label="🗑️ Endpoint" title="Remove endpoint" size="xs" />
                    )}
                    {hasKey && (
                        <DeleteConfirmButtons onConfirm={handleDeleteKey} label="🗑️ Key" title="Remove API key" size="xs" />
                    )}
                    <button
                        onClick={handleSave}
                        disabled={saving || (!endpoint.trim() && !apiKey.trim() && models === savedModels)}
                        className="px-5 py-2.5 rounded-lg font-medium text-white text-sm transition-all disabled:opacity-50"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {saving ? '...' : 'Save'}
                    </button>
                </div>
            </div>
        </ProviderCardShell>
    );
};

export default AzureConfigCard;
