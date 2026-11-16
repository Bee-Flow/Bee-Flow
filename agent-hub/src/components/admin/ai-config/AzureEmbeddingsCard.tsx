// The Azure OpenAI embedding deployment the Azure document pipeline embeds
// knowledge-base documents with (when Azure document processing is on, under
// Platform services > Connected apps). It sat among the connected apps; it
// belongs with the other embedding settings, so it is a group of Search &
// retrieval now. Endpoint and key are write-only: a stored one shows as dots.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { aiConfigKey, useAiConfigQuery } from '@/api/queries/aiConfigRead';
import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';
import { CHIP, CHIP_SUCCESS } from '@/components/shared/adminUi';
import SaveFooter from '@/components/shared/SaveFooter';
import { FIELD_INPUT, Field, FieldGrid, SettingBlock, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import toast from '@/components/shared/Toast';
import { useTranslation } from '@/hooks/useTranslation';

interface AzureEmbedRead {
    hasAzureOpenaiEmbeddingEndpoint?: boolean;
    hasAzureOpenaiEmbeddingKey?: boolean;
    azureOpenaiEmbeddingModel?: string;
    useAzureDocProcessing?: boolean;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const MASK = '••••••••••••••••';
const DEPLOYMENTS = [
    { id: 'text-embedding-3-small', dims: 1536 },
    { id: 'text-embedding-3-large', dims: 3072 },
    { id: 'text-embedding-ada-002', dims: 1536 },
] as const;

/** The form: write-only endpoint and key, the deployment, and its save. */
function useAzureEmbedForm() {
    const { t } = useTranslation();
    const queryClient = useQueryClient();
    const stored = useAiConfigQuery<AzureEmbedRead>().data?.config;
    const storedModel = stored?.azureOpenaiEmbeddingModel || 'text-embedding-3-small';
    const [endpoint, setEndpoint] = useState('');
    const [apiKey, setApiKey] = useState('');
    const [model, setModel] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<SaveState>('idle');
    const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
    const chosenModel = model ?? storedModel;
    const reset = () => { setEndpoint(''); setApiKey(''); setModel(null); };

    const save = async () => {
        setSaveState('saving');
        const body: Record<string, string> = { azureOpenaiEmbeddingModel: chosenModel };
        if (endpoint.trim()) body.azureOpenaiEmbeddingEndpoint = endpoint.trim();
        if (apiKey.trim()) body.azureOpenaiEmbeddingKey = apiKey.trim();
        try {
            await apiRequest('POST /ai/config', { body });
            await queryClient.invalidateQueries({ queryKey: aiConfigKey });
            reset();
            setSaveState('saved');
            setLastSavedAt(new Date());
            toast.success(t('ai_model_setup.azure_embed_saved', 'Azure OpenAI embedding settings saved'));
        } catch (err) {
            if (!(err instanceof ApiError)) throw err;
            setSaveState('error');
            toast.error(t('ai_model_setup.azure_embed_failed', 'The Azure OpenAI embedding settings could not be saved'));
        }
    };

    return {
        stored, endpoint, setEndpoint, apiKey, setApiKey, chosenModel, setModel, saveState, lastSavedAt, save, reset,
        dirty: !!endpoint.trim() || !!apiKey.trim() || chosenModel !== storedModel,
        connected: !!stored?.hasAzureOpenaiEmbeddingEndpoint && !!stored?.hasAzureOpenaiEmbeddingKey,
    };
}

type AzureEmbedForm = ReturnType<typeof useAzureEmbedForm>;

function DeploymentFields({ form }: { form: AzureEmbedForm }) {
    const { t } = useTranslation();
    return (
        <SettingBlock
            label={t('ai_model_setup.azure_embed_connection', 'Deployment')}
            hint={<>
                {t('ai_model_setup.azure_embed_hint', 'Deploy an embedding model in')}{' '}
                <a href="https://oai.azure.com" target="_blank" rel="noopener noreferrer" className="underline hover:text-[var(--text-primary)]">Azure OpenAI Studio</a>.
            </>}
        >
            <div className="flex flex-col gap-2 sm:flex-row">
                <input
                    type="text"
                    value={form.endpoint}
                    onChange={e => form.setEndpoint(e.target.value)}
                    placeholder={form.stored?.hasAzureOpenaiEmbeddingEndpoint ? MASK : 'https://your-resource.openai.azure.com'}
                    aria-label={t('ai_model_setup.rerank_azure_endpoint', 'Endpoint')}
                    className={FIELD_INPUT}
                />
                <input
                    type="password"
                    value={form.apiKey}
                    onChange={e => form.setApiKey(e.target.value)}
                    placeholder={form.stored?.hasAzureOpenaiEmbeddingKey ? MASK : t('ai_model_setup.azure_embed_key', 'API key')}
                    aria-label={t('ai_model_setup.azure_embed_key', 'API key')}
                    className={FIELD_INPUT}
                />
            </div>
            <FieldGrid>
                <Field label={t('admin_ai_config.embed_model', 'Embedding Model')} htmlFor="azure-embed-model">
                    <select id="azure-embed-model" value={form.chosenModel} onChange={e => form.setModel(e.target.value)} className={FIELD_INPUT}>
                        {DEPLOYMENTS.map(d => (
                            <option key={d.id} value={d.id}>{t('ai_model_setup.azure_embed_option', '{model} ({dims} dimensions)', { model: d.id, dims: d.dims })}</option>
                        ))}
                    </select>
                </Field>
            </FieldGrid>
        </SettingBlock>
    );
}

export default function AzureEmbeddingsCard() {
    const { t } = useTranslation();
    const form = useAzureEmbedForm();
    return (
        <SettingsGroup
            title={(
                <span className="flex items-center gap-2">
                    {t('ai_model_setup.azure_embed_title', 'Azure OpenAI embeddings')}
                    <span className={form.connected ? CHIP_SUCCESS : CHIP}>
                        {form.connected ? t('admin_ai_config.status_connected', 'Connected') : t('admin_ai_config.status_not_connected', 'Not connected')}
                    </span>
                </span>
            )}
            description={form.stored?.useAzureDocProcessing
                ? t('ai_model_setup.azure_embed_on', 'Azure document processing is on: knowledge-base documents are embedded with this deployment, not with the embedding model above.')
                : t('ai_model_setup.azure_embed_off', 'Used only while Azure document processing is on (Platform services > Connected apps). It is off, so the embedding model above is used.')}
        >
            <SettingsList>
                <DeploymentFields form={form} />
            </SettingsList>
            <SaveFooter
                onSave={() => { void form.save(); }}
                onCancel={form.dirty ? form.reset : undefined}
                saving={form.saveState === 'saving'}
                dirty={form.dirty}
                saveState={form.saveState}
                lastSavedAt={form.lastSavedAt}
            />
        </SettingsGroup>
    );
}
