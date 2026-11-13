import { useState } from 'react';
import type { ProviderPaneProps } from './types';
import useProviderConfig from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';
import { rowsFromConfig, rowsSignature, rowsToConfig } from './azureImageRows';
import type { AzureImageRow } from './azureImageRows';

/** The state and handlers of the form: what is typed, what is stored, save and the two removals. */
export function useAzureForm({ onMessage }: ProviderPaneProps) {
    const { t } = useTranslation();
    const [endpoint, setEndpoint] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [models, setModels] = useState('');
    const [savedModels, setSavedModels] = useState('');
    // The image deployments, and what is stored, to tell an edit apart.
    const [imageRows, setImageRows] = useState<AzureImageRow[]>([]);
    const [savedImageRows, setSavedImageRows] = useState(() => rowsSignature([]));

    const { config, saving, save, deleteKey, deleteSetting, patchConfig } = useProviderConfig({
        onMessage,
        onLoaded: data => {
            if (data.azureModels) {
                setSavedModels(data.azureModels);
                setModels(data.azureModels);
            }
            const rows = rowsFromConfig(data.azureImageModels);
            setImageRows(rows);
            setSavedImageRows(rowsSignature(rows));
        }
    });
    const hasEndpoint = !!config?.hasAzureEndpoint;
    const hasKey = !!config?.hasAzureApiKey;
    const imagesChanged = rowsSignature(imageRows) !== savedImageRows;

    const handleSave = async () => {
        if (!endpoint.trim() && !apiKey.trim() && !models.trim() && !imagesChanged) return;
        const images = rowsToConfig(imageRows);
        if (!images.ok) {
            onMessage?.({
                type: 'error',
                text: images.reason === 'price'
                    ? t('azure_image_deployments.price_invalid', 'A price per image is a number from 0 to 1000, or empty.')
                    : t('azure_image_deployments.too_many', 'At most 20 image deployments.'),
            });
            return;
        }
        const body: Record<string, unknown> = {};
        if (endpoint.trim()) body.azureEndpoint = endpoint;
        if (apiKey.trim()) body.azureApiKey = apiKey;
        body.azureModels = models.trim();
        body.azureImageModels = images.value;

        const ok = await save(body, { success: t('admin_ai_config.azure_saved', 'Azure AI config saved!'), error: t('admin_ai_config.provider_save_failed', 'Failed to save config') });
        if (ok) {
            patchConfig({
                ...(endpoint.trim() ? { hasAzureEndpoint: true } : {}),
                ...(apiKey.trim() ? { hasAzureApiKey: true } : {}),
                azureImageModels: images.value,
            });
            setSavedModels(models.trim());
            setSavedImageRows(rowsSignature(imageRows));
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

    return { t, endpoint, setEndpoint, apiKey, setApiKey, models, setModels, savedModels, imageRows, setImageRows, imagesChanged, saving, hasEndpoint, hasKey, handleSave, handleDeleteKey, handleDeleteEndpoint };
}
