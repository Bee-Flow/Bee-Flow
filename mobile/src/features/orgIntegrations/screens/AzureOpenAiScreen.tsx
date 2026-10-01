/**
 * Azure OpenAI (web: integrations/azure/OpenAISection.jsx): the resource
 * endpoint, its API key and the deployed model names — the list the chat
 * tiers then pick from. There is no API version: the server always uses
 * Azure's v1 GA API.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Badge, BadgeRow, Group, SaveBar, TextField } from '@/shared/ui';

import { FieldsGroup } from '../components/FieldsGroup';
import { useAzureScreen } from '../hooks/useAzureScreen';
import { useAzureSectionForm } from '../hooks/useAzureSectionForm';
import { deployedModels, validEndpoint } from '../model/azure';

/** Example values, as the web's fields show them. */
const MODELS_EXAMPLE = 'gpt-4.1, gpt-5-mini, gpt-5.4';

interface OpenAiDraft {
    azureEndpoint: string;
    azureApiKey: string;
    azureModels: string;
}

export function AzureOpenAiScreen() {
    const t = useTranslation();
    const azure = useAzureScreen();
    const config = azure.query.data;
    const { form, saving, save } = useAzureSectionForm<OpenAiDraft>(
        azure.orgId,
        config ? { azureEndpoint: config.azureEndpoint, azureApiKey: '', azureModels: config.azureModels } : null,
        (d) => ({
            section: 'openai',
            azureEndpoint: d.azureEndpoint.trim(),
            ...(d.azureApiKey.trim() ? { azureApiKey: d.azureApiKey.trim() } : {}),
            azureModels: d.azureModels.trim(),
        }),
    );
    const endpointOk = validEndpoint(form.draft?.azureEndpoint ?? '');
    useConfirmLeave(form.dirty);

    return (
        <OrgSettingsFrame
            title={t('azure.openai_title', 'Azure OpenAI Service')}
            subtitle={azure.subtitle}
            allowed={azure.allowed}
            denied={azure.denied}
            query={azure.query}
            footer={
                <SaveBar
                    dirty={form.dirty}
                    saving={saving}
                    blockedReason={endpointOk ? null : t('azure.endpoint_help', 'Your Azure OpenAI resource endpoint (e.g. https://myresource.openai.azure.com)')}
                    onSave={() => void save()}
                    onDiscard={form.reset}
                />
            }
        >
            {(data) => {
                const d = form.draft ?? { ...data, azureApiKey: '' };
                const models = deployedModels(d.azureModels).length;
                return (
                    <>
                        <Group footer={t('azure.openai_section_desc', 'Configure your Azure OpenAI deployment endpoint, API key, and available models. These are the same settings visible in the admin dashboard.')}>
                            <BadgeRow label={t('azure.openai_status', 'Azure AI')}>
                                {data.azureEndpoint ? <Badge label={t('azure.endpoint_badge', 'Endpoint')} tone="success" /> : null}
                                {data.hasAzureApiKey ? <Badge label={t('azure.key_badge', 'Key')} tone="success" /> : null}
                                {models > 0 ? <Badge label={t('mobile.orgIntegrations.azure_models', '{n} model(s)', { n: models })} tone="info" /> : null}
                            </BadgeRow>
                        </Group>
                        <FieldsGroup>
                            <TextField
                                testID="azure-endpoint"
                                label={t('azure.endpoint_url', 'Endpoint URL')}
                                placeholder={t('mobile.orgIntegrations.azure_endpoint_ph', 'https://your-resource.openai.azure.com')}
                                hint={t('azure.endpoint_help', 'Your Azure OpenAI resource endpoint (e.g. https://myresource.openai.azure.com)')}
                                keyboardType="url"
                                autoCapitalize="none"
                                value={d.azureEndpoint}
                                onChangeText={(v) => form.set('azureEndpoint', v)}
                            />
                            <TextField
                                testID="azure-api-key"
                                // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- an i18n key and its English label, not an API key
                                label={t('azure.api_key', 'API Key')}
                                placeholder={data.hasAzureApiKey ? '••••••••••••' : t('mobile.orgIntegrations.azure_key_ph', 'Enter Azure OpenAI API key')}
                                hint={
                                    data.hasAzureApiKey
                                        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- an i18n key and its English help text, not an API key
                                        ? t('azure.api_key_help_set', 'Key is configured. Enter a new value to replace it.')
                                        // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- an i18n key and its English help text, not an API key
                                        : t('azure.api_key_help_empty', 'Found in Azure Portal → your OpenAI resource → Keys and Endpoint')
                                }
                                secure
                                value={d.azureApiKey}
                                onChangeText={(v) => form.set('azureApiKey', v)}
                            />
                            <TextField
                                testID="azure-models"
                                label={t('azure.deployed_models', 'Deployed Model Names')}
                                placeholder={MODELS_EXAMPLE}
                                hint={t('azure.deployed_models_help', 'Comma-separated list of your Azure deployment names. Use name=model when a deployment is not named after its model (e.g. prod-chat=gpt-6-astra)')}
                                autoCapitalize="none"
                                value={d.azureModels}
                                onChangeText={(v) => form.set('azureModels', v)}
                            />
                        </FieldsGroup>
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
