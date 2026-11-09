import React from 'react';
import type { ProviderPaneProps } from './types';
import DeleteConfirmButtons from '../ProviderCards/shared/DeleteConfirmButtons';
import SecretInput from '../ProviderCards/shared/SecretInput';
import { PRIMARY_BTN, INPUT, HINT } from '@/components/mcpLibrary/ui';
import Section from '@/components/shared/Section';
import { useAzureForm } from './useAzureForm';

const AzureForm = ({ onMessage }: ProviderPaneProps) => {
    const { t, endpoint, setEndpoint, apiKey, setApiKey, models, setModels, savedModels, saving, hasEndpoint, hasKey, handleSave, handleDeleteKey, handleDeleteEndpoint } = useAzureForm({ onMessage });

    return (
        <Section title={t('admin_ai_config.azure_section', 'Connection')}>
          <div className="space-y-3">
            {/* Endpoint URL */}
            <div>
                <input
                    type="text"
                    value={endpoint}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEndpoint(e.target.value)}
                    placeholder={hasEndpoint ? '••••••••••••••••' : 'https://your-resource.openai.azure.com'}
                    className={INPUT}
                />
            </div>

            {/* API Key. No API version: Bee Flow always uses Azure's v1 GA API. */}
            <div className="flex gap-2">
                <SecretInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder={hasKey ? '••••••••••••••••' : t('admin_ai_config.azure_key_placeholder', 'Azure API Key')}
                />
            </div>

            {/* Models input */}
            <div>
                <input
                    type="text"
                    value={models}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setModels(e.target.value)}
                    placeholder={t('admin_ai_config.azure_models_placeholder', 'Deployment names, e.g. gpt-5.6-terra, prod-chat=gpt-6-astra, gpt-4.1')}
                    className={INPUT}
                    title={t('admin_ai_config.azure_models_title', 'Comma-separated list of your Azure deployment names')}
                />
                <p className={HINT}>
                    {t('admin_ai_config.azure_models_hint', 'Comma-separated deployment names from your Azure portal. If a deployment is not named after its model, write name=model (prod-chat=gpt-6-astra).')}
                </p>
            </div>

            {/* Help + Save */}
            <div className="flex items-center justify-between">
                <div className="flex gap-2 flex-wrap">
                    <p className="text-xs self-center text-[var(--text-muted)]">
                        {t('admin_ai_config.get_from', 'Get from')} <a href="https://portal.azure.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--accent-primary)]">portal.azure.com</a>
                    </p>
                </div>
                <div className="flex gap-2 items-center">
                    {hasEndpoint && (
                        <DeleteConfirmButtons onConfirm={handleDeleteEndpoint} label={t('admin_ai_config.delete_endpoint', '🗑️ Endpoint')} title={t('admin_ai_config.remove_endpoint', 'Remove endpoint')} size="xs" />
                    )}
                    {hasKey && (
                        /* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */
                        <DeleteConfirmButtons onConfirm={handleDeleteKey} label={t('admin_ai_config.delete_key', '🗑️ Key')} title={t('admin_ai_config.remove_api_key', 'Remove API key')} size="xs" />
                    )}
                    <button
                        type="button"
                        onClick={handleSave}
                        disabled={saving || (!endpoint.trim() && !apiKey.trim() && models === savedModels)}
                        className={PRIMARY_BTN}
                    >
                        {saving ? '...' : t('admin_ai_config.save', 'Save')}
                    </button>
                </div>
            </div>
          </div>
        </Section>
    );
};

export default AzureForm;
