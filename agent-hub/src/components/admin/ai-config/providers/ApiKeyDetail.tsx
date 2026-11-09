// The API-key section of a provider detail: one secret key, saved with the
// button or Enter, replaced by saving a new one, removed with a two-step
// confirm. The state lives in useProviderConfig (GET/POST /ai/config), shared
// with the list so a saved key moves the provider to "Connected" at once.

import { useState } from 'react';
import DeleteConfirmButtons from '../ProviderCards/shared/DeleteConfirmButtons';
import SecretInput from '../ProviderCards/shared/SecretInput';
import type { ProviderKeyConfig } from '../ProviderCards/providerKeyConfig';
import type { ProviderTexts } from './providerTexts';
import type { ProviderPaneProps } from './types';
import Section from '@/components/shared/Section';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import useProviderConfig from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';

interface ApiKeyDetailProps extends ProviderPaneProps {
    provider: ProviderKeyConfig;
    texts: ProviderTexts;
    children?: React.ReactNode;
}

export default function ApiKeyDetail({ provider, texts, onMessage, children }: ApiKeyDetailProps) {
    const { t } = useTranslation();
    const { name, statusField, bodyField, deleteSlug } = provider;
    const [apiKey, setApiKey] = useState('');
    const [showKey, setShowKey] = useState(false);
    const { config, saving, save, deleteKey, patchConfig } = useProviderConfig({ onMessage });
    const hasKey = !!config?.[statusField];

    const handleSave = async () => {
        if (!apiKey.trim()) return;
        const ok = await save({ [bodyField]: apiKey }, {
            success: t('admin_ai_config.apikey_saved', '{name} API key saved!', { name }),
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
            error: t('admin_ai_config.apikey_save_failed', 'Failed to save API key'),
        });
        if (ok) {
            patchConfig({ [statusField]: true });
            setApiKey('');
            setShowKey(false);
        }
    };

    const handleDelete = async () => {
        const ok = await deleteKey(deleteSlug, {
            success: t('admin_ai_config.apikey_removed', '{name} API key removed', { name }),
            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential
            error: t('admin_ai_config.apikey_delete_failed', 'Failed to delete API key'),
        });
        if (ok) {
            patchConfig({ [statusField]: false });
            setApiKey('');
        }
    };

    return (
        <Section
            title={t('admin_ai_config.provider_key_section', 'API key')}
            description={hasKey ? t('admin_ai_config.provider_key_replace_hint', 'A key is stored. Enter a new one to replace it.') : undefined}
        >
            <div className="flex gap-2">
                <SecretInput
                    value={apiKey}
                    onChange={setApiKey}
                    placeholder={hasKey ? '••••••••••••••••' : texts.placeholder}
                    onEnter={handleSave}
                    show={showKey}
                    onToggleShow={setShowKey}
                />
                <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !apiKey.trim()}
                    className={PRIMARY_BTN}
                >
                    {saving ? '...' : hasKey ? t('admin_ai_config.provider_key_replace', 'Replace key') : t('admin_ai_config.save', 'Save')}
                </button>
                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                {hasKey && <DeleteConfirmButtons onConfirm={handleDelete} title={t('admin_ai_config.apikey_delete_title', 'Delete API key')} />}
            </div>
            {children}
        </Section>
    );
}
