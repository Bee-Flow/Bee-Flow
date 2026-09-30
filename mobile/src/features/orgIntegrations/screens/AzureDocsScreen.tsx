/**
 * Azure document processing (web: integrations/azure/DocProcessingSection.jsx):
 * whether knowledge-base uploads go through Azure AI Document Intelligence
 * and Azure OpenAI embeddings instead of local processing, and their
 * endpoints, keys and embedding model. An empty endpoint or key keeps the
 * stored one.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { ChoiceGroup, OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Group, SaveBar, TextField, ToggleRow } from '@/shared/ui';

import { FieldsGroup } from '../components/FieldsGroup';
import { useAzureScreen } from '../hooks/useAzureScreen';
import { useAzureSectionForm } from '../hooks/useAzureSectionForm';
import { validEndpoint } from '../model/azure';

interface DocsDraft {
    useAzureDocProcessing: boolean;
    docEndpoint: string;
    docKey: string;
    embedEndpoint: string;
    embedKey: string;
    embedModel: string;
}

const EMBED_MODELS = ['text-embedding-3-small', 'text-embedding-3-large', 'text-embedding-ada-002'] as const;
const DIMENSIONS: Readonly<Record<string, number>> = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072, 'text-embedding-ada-002': 1536 };

const orUndefined = (v: string) => v.trim() || undefined;

export function AzureDocsScreen() {
    const t = useTranslation();
    const azure = useAzureScreen();
    const c = azure.query.data;
    const { form, saving, save } = useAzureSectionForm<DocsDraft>(
        azure.orgId,
        c ? { useAzureDocProcessing: c.useAzureDocProcessing, docEndpoint: c.azureDocEndpoint, docKey: '', embedEndpoint: c.azureEmbedEndpoint, embedKey: '', embedModel: c.azureEmbedModel } : null,
        (d) => ({
            section: 'docProcessing',
            useAzureDocProcessing: d.useAzureDocProcessing,
            azureDocIntelligenceEndpoint: orUndefined(d.docEndpoint),
            azureDocIntelligenceKey: orUndefined(d.docKey),
            azureOpenaiEmbeddingEndpoint: orUndefined(d.embedEndpoint),
            azureOpenaiEmbeddingKey: orUndefined(d.embedKey),
            azureOpenaiEmbeddingModel: d.embedModel,
        }),
    );
    const valid = form.draft ? validEndpoint(form.draft.docEndpoint) && validEndpoint(form.draft.embedEndpoint) : true;
    useConfirmLeave(form.dirty);
    const keyHint = (has: boolean, empty: string) => (has ? t('azure.key_configured', 'Key is configured. Enter a new value to replace it.') : empty);

    return (
        <OrgSettingsFrame
            title={t('azure.doc_processing_title', 'Azure Document Processing')}
            subtitle={azure.subtitle}
            allowed={azure.allowed}
            denied={azure.denied}
            query={azure.query}
            footer={
                <SaveBar
                    dirty={form.dirty}
                    saving={saving}
                    blockedReason={valid ? null : t('mobile.orgIntegrations.azure_bad_endpoint', 'An endpoint is an https:// address, or empty.')}
                    onSave={() => void save()}
                    onDiscard={form.reset}
                />
            }
        >
            {(data) => {
                const d = form.draft ?? { useAzureDocProcessing: data.useAzureDocProcessing, docEndpoint: '', docKey: '', embedEndpoint: '', embedKey: '', embedModel: data.azureEmbedModel };
                return (
                    <>
                        <Group footer={t('azure.doc_processing_section_desc', 'Use Azure AI Document Intelligence for high-quality document extraction and Azure OpenAI for vector embeddings in Knowledge Bases.')}>
                            <ToggleRow
                                testID="azure-doc-toggle"
                                label={t('azure.doc_processing_toggle', 'Use Azure for Knowledge Bases')}
                                description={t('azure.doc_processing_toggle_desc', 'All file uploads will use Azure Document Intelligence + Azure OpenAI embeddings instead of local processing.')}
                                value={d.useAzureDocProcessing}
                                onValueChange={(v) => form.set('useAzureDocProcessing', v)}
                            />
                        </Group>
                        <FieldsGroup title={t('azure.doc_intelligence_label', 'Document Intelligence')}>
                            <TextField
                                testID="azure-doc-endpoint"
                                label={t('azure.doc_intelligence_endpoint', 'Document Intelligence Endpoint')}
                                placeholder={t('mobile.orgIntegrations.azure_doc_endpoint_ph', 'https://your-resource.cognitiveservices.azure.com')}
                                hint={t('azure.doc_intelligence_endpoint_help', 'Create a resource at Azure Portal → AI Document Intelligence.')}
                                autoCapitalize="none"
                                value={d.docEndpoint}
                                onChangeText={(v) => form.set('docEndpoint', v)}
                            />
                            <TextField
                                testID="azure-doc-key"
                                label={t('azure.doc_intelligence_key', 'API Key')}
                                placeholder={data.hasAzureDocKey ? '••••••••••••' : undefined}
                                hint={keyHint(data.hasAzureDocKey, t('azure.doc_intelligence_key_help', 'Found in Azure Portal → your Document Intelligence resource → Keys and Endpoint.'))}
                                secure
                                value={d.docKey}
                                onChangeText={(v) => form.set('docKey', v)}
                            />
                        </FieldsGroup>
                        <FieldsGroup title={t('azure.embed_label', 'Azure OpenAI Embeddings')}>
                            <TextField
                                testID="azure-embed-endpoint"
                                label={t('azure.embed_endpoint', 'Embedding Endpoint')}
                                placeholder={t('mobile.orgIntegrations.azure_endpoint_ph', 'https://your-resource.openai.azure.com')}
                                hint={t('azure.embed_endpoint_help', 'Deploy an embedding model in your Azure OpenAI Studio.')}
                                autoCapitalize="none"
                                value={d.embedEndpoint}
                                onChangeText={(v) => form.set('embedEndpoint', v)}
                            />
                            <TextField
                                testID="azure-embed-key"
                                label={t('azure.embed_key', 'API Key')}
                                placeholder={data.hasAzureEmbedKey ? '••••••••••••' : undefined}
                                hint={keyHint(data.hasAzureEmbedKey, t('azure.embed_key_help', 'Found in Azure Portal → your OpenAI resource → Keys and Endpoint.'))}
                                secure
                                value={d.embedKey}
                                onChangeText={(v) => form.set('embedKey', v)}
                            />
                        </FieldsGroup>
                        <ChoiceGroup
                            title={t('azure.embed_model', 'Embedding Model')}
                            footer={t('azure.embed_model_help', 'Select the deployment name for your Azure OpenAI embedding model. Used for KB document embeddings when Azure processing is enabled.')}
                            choices={EMBED_MODELS.map((m) => ({ value: m, label: `${m} (${DIMENSIONS[m]} dims)` }))}
                            value={d.embedModel}
                            onChange={(v) => form.set('embedModel', v)}
                        />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
