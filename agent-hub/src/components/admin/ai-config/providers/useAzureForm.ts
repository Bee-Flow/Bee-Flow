import { useState } from 'react';
import type { ProviderPaneProps } from './types';
import useProviderConfig from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';

/** The state and handlers of the form: what is typed, what is stored, save and the two removals. */
export function useAzureForm({ onMessage }: ProviderPaneProps) {
    const { t } = useTranslation();
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
        const body: Record<string, string> = {};
        if (endpoint.trim()) body.azureEndpoint = endpoint;
        if (apiKey.trim()) body.azureApiKey = apiKey;
        body.azureModels = models.trim();

        const ok = await save(body, { success: t('admin_ai_config.azure_saved', 'Azure AI config saved!'), error: t('admin_ai_config.provider_save_failed', 'Failed to save config') });
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
        const ok = await deleteKey('azure_api_key', { success: t('admin_ai_config.azure_key_removed', 'Azure API key removed'), error: t('admin_ai_config.azure_key_delete_failed', 'Failed to delete Azure API key') });
        if (ok) {
            patchConfig({ hasAzureApiKey: false });
            setApiKey('');
        }
    };

    const handleDeleteEndpoint = async () => {
        const ok = await deleteSetting('azure_endpoint', { success: t('admin_ai_config.azure_endpoint_removed', 'Azure endpoint removed'), error: t('admin_ai_config.azure_endpoint_delete_failed', 'Failed to delete Azure endpoint') });
        if (ok) {
            patchConfig({ hasAzureEndpoint: false });
            setEndpoint('');
        }
    };

    return { t, endpoint, setEndpoint, apiKey, setApiKey, models, setModels, savedModels, saving, hasEndpoint, hasKey, handleSave, handleDeleteKey, handleDeleteEndpoint };
}
