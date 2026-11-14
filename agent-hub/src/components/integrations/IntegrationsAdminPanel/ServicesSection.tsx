// "Services" section of the IntegrationsAdminPanel: the OAuth apps users
// connect through (LinkedIn, Withings) and Azure Document Processing for the
// knowledge bases. One settings group per service; the bindings are threaded
// in as props from the panel.
import type React from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { FIELD_INPUT, Field, FieldGrid, SettingRow, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import SectionHeader from '@/components/shared/SectionHeader';
import Toggle from '@/components/shared/Toggle';
import type { ServicesSectionProps, SetMessage } from './adminPanel.types';
import { HINT_LINK, Hint, SaveButton, StatusChip } from './ui';
import { ApiError } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

const MASK = '••••••••••••••••';

/** POST /ai/config; null when the server refused. */
function postConfig(body: Record<string, unknown>) {
    return apiRequest('POST /ai/config', { body }).catch((err: unknown) => {
        if (err instanceof ApiError) return null;
        throw err;
    });
}

/** Run one save: flag on, the request, a message, flag off, the message gone after 3 s. */
async function runSave(setSaving: (v: boolean) => void, setMessage: SetMessage, fail: string, work: () => Promise<void>) {
    setSaving(true);
    try {
        await work();
    } catch (e) {
        setMessage({ type: 'error', text: fail });
    }
    setSaving(false);
    setTimeout(() => setMessage(null), 3000);
}

interface OAuthAppGroupProps {
    logo: ReactNode;
    title: string;
    description: string;
    configured: boolean;
    clientId: string;
    setClientId: (v: string) => void;
    clientSecret: string;
    setClientSecret: (v: string) => void;
    saving: boolean;
    onSave: () => void;
    hint: ReactNode;
}

/** A client id and secret of an OAuth app, saved together. */
function OAuthAppGroup({ logo, title, description, configured, clientId, setClientId, clientSecret, setClientSecret, saving, onSave, hint }: OAuthAppGroupProps) {
    const { t } = useTranslation();
    return (
        <SettingsGroup
            title={<span className="flex items-center gap-2">{logo}{title}{configured && <StatusChip>{t('integ.services_configured', 'Configured')}</StatusChip>}</span>}
            description={description}
        >
            <SettingsList>
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
                    <input type="text" value={clientId} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientId(e.target.value)} placeholder={configured ? MASK : 'Client ID'} className={FIELD_INPUT} />
                    <input type="password" value={clientSecret} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setClientSecret(e.target.value)} placeholder={configured ? MASK : 'Client Secret'} className={FIELD_INPUT} />
                    <SaveButton saving={saving} disabled={!clientId.trim() || !clientSecret.trim()} onClick={onSave}>{t('integ.services_save', 'Save')}</SaveButton>
                </div>
            </SettingsList>
            <Hint>{hint}</Hint>
        </SettingsGroup>
    );
}

const LINKEDIN_LOGO = <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="4" fill="#0A66C2" /><path d="M7.5 9.5h2v7h-2v-7zm1-3.2a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4zm3.5 3.2h1.9v1h0c.27-.5 .92-1.1 1.9-1.1 2 0 2.4 1.3 2.4 3.1v3.6h-2v-3.2c0-.8 0-1.8-1.1-1.8s-1.3.9-1.3 1.7v3.3h-2v-6.6z" fill="white" /></svg>;
const WITHINGS_LOGO = <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="2" y="2" width="20" height="20" rx="4" fill="#00A9A6" /><path d="M5 12.5h3l1.6-3.4 2.3 6 1.7-3.6H19" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
const AZURE_LOGO = <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z" fill="#0078D4" /><path d="M2 17l10 5 10-5" stroke="#0078D4" strokeWidth="2" fill="none" /><path d="M2 12l10 5 10-5" stroke="#50A0E0" strokeWidth="2" fill="none" /></svg>;

function LinkedInGroup(p: ServicesSectionProps) {
    const { t } = useTranslation();
    const save = () => {
        if (!p.linkedinClientId.trim() || !p.linkedinClientSecret.trim()) return;
        void runSave(p.setSavingLinkedIn, p.setMessage, 'Failed to save LinkedIn credentials', async () => {
            if (await postConfig({ linkedinClientId: p.linkedinClientId, linkedinClientSecret: p.linkedinClientSecret })) {
                p.setHasLinkedInConfig(true);
                p.setLinkedinClientId('');
                p.setLinkedinClientSecret('');
                p.setMessage({ type: 'success', text: 'LinkedIn credentials saved' });
            }
        });
    };
    return (
        <OAuthAppGroup
            logo={LINKEDIN_LOGO}
            title={t('integ.services_linkedin_configuration', 'LinkedIn Configuration')}
            description={t('integ.services_set_linkedin_api_credentials_users_can', 'Set LinkedIn API credentials. Users can then connect their LinkedIn accounts from Settings → Connections.')}
            configured={p.hasLinkedInConfig}
            clientId={p.linkedinClientId} setClientId={p.setLinkedinClientId}
            clientSecret={p.linkedinClientSecret} setClientSecret={p.setLinkedinClientSecret}
            saving={p.savingLinkedIn} onSave={save}
            hint={<>{t('integ.services_get_credentials_from_your', 'Get credentials from your')} <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.services_linkedin_developer_app', 'LinkedIn Developer App')}</a> {t('integ.services_enable_share_on_linkedin_sign_in_with', '— enable "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect".')}</>}
        />
    );
}

function WithingsGroup(p: ServicesSectionProps) {
    const { t } = useTranslation();
    const save = () => {
        if (!p.withingsClientId.trim() || !p.withingsClientSecret.trim()) return;
        void runSave(p.setSavingWithings, p.setMessage, 'Failed to save Withings credentials', async () => {
            if (await postConfig({ withingsClientId: p.withingsClientId, withingsClientSecret: p.withingsClientSecret })) {
                p.setHasWithingsConfig(true);
                p.setWithingsClientId('');
                p.setWithingsClientSecret('');
                p.setMessage({ type: 'success', text: 'Withings credentials saved' });
            }
        });
    };
    return (
        <OAuthAppGroup
            logo={WITHINGS_LOGO}
            title={t('integ.services_withings_configuration', 'Withings Configuration')}
            description={t('integ.services_set_withings_api_credentials_users_can', 'Set Withings API credentials. Users can then connect their Health Mate accounts from Settings → Connections.')}
            configured={p.hasWithingsConfig}
            clientId={p.withingsClientId} setClientId={p.setWithingsClientId}
            clientSecret={p.withingsClientSecret} setClientSecret={p.setWithingsClientSecret}
            saving={p.savingWithings} onSave={save}
            hint={<>{t('integ.services_register_an_app_in_the', 'Register an app in the')} <a href="https://developer.withings.com/dashboard/" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.services_withings_developer_dashboard', 'Withings Developer Dashboard')}</a> {t('integ.services_and_set_its_callback_url_to', 'and set its callback URL to')} <code>{`${window.location.origin}/api/integrations/withings/callback`}</code>{t('integ.services_withings_requires_an_https_callback_so', '. Withings requires an HTTPS callback, so a local deployment needs a tunnel.')}</>}
        />
    );
}

function AzureDocIntelligenceRow(p: ServicesSectionProps) {
    const { t } = useTranslation();
    const empty = !p.azureDocEndpoint.trim() && !p.azureDocKey.trim();
    const save = () => {
        if (empty) return;
        void runSave(p.setSavingAzureDoc, p.setMessage, 'Failed to save credentials', async () => {
            const body: Record<string, string> = {};
            if (p.azureDocEndpoint.trim()) body.azureDocIntelligenceEndpoint = p.azureDocEndpoint;
            if (p.azureDocKey.trim()) body.azureDocIntelligenceKey = p.azureDocKey;
            if (await postConfig(body)) {
                if (p.azureDocEndpoint.trim()) p.setHasAzureDocEndpoint(true);
                if (p.azureDocKey.trim()) p.setHasAzureDocKey(true);
                p.setAzureDocEndpoint('');
                p.setAzureDocKey('');
                p.setMessage({ type: 'success', text: 'Document Intelligence credentials saved' });
            }
        });
    };
    return (
        <SettingRow
            label={<span className="flex items-center gap-2">{t('integ.services_document_intelligence', 'Document Intelligence')}{p.hasAzureDocEndpoint && p.hasAzureDocKey && <StatusChip>{t('integ.services_connected', 'Connected')}</StatusChip>}</span>}
            hint={<>{t('integ.services_create_a_resource_at', 'Create a resource at')} <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesFormRecognizer" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.services_azure_portal_ai_document_intelligence', 'Azure Portal → AI Document Intelligence')}</a>.</>}
            expanded={(
                <div className="flex flex-col gap-2 sm:flex-row">
                    <input type="text" value={p.azureDocEndpoint} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setAzureDocEndpoint(e.target.value)} placeholder={p.hasAzureDocEndpoint ? MASK : 'https://your-resource.cognitiveservices.azure.com'} className={FIELD_INPUT} />
                    <input type="password" value={p.azureDocKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setAzureDocKey(e.target.value)} placeholder={p.hasAzureDocKey ? MASK : 'API Key'} className={FIELD_INPUT} />
                    <SaveButton saving={p.savingAzureDoc} disabled={empty} onClick={save}>{t('integ.services_save', 'Save')}</SaveButton>
                </div>
            )}
        />
    );
}

function AzureEmbeddingsRow(p: ServicesSectionProps) {
    const { t } = useTranslation();
    const empty = !p.azureEmbedEndpoint.trim() && !p.azureEmbedKey.trim();
    const save = () => {
        if (empty) return;
        void runSave(p.setSavingAzureEmbed, p.setMessage, 'Failed to save credentials', async () => {
            const body: Record<string, string> = { azureOpenaiEmbeddingModel: p.azureEmbedModel };
            if (p.azureEmbedEndpoint.trim()) body.azureOpenaiEmbeddingEndpoint = p.azureEmbedEndpoint;
            if (p.azureEmbedKey.trim()) body.azureOpenaiEmbeddingKey = p.azureEmbedKey;
            if (await postConfig(body)) {
                if (p.azureEmbedEndpoint.trim()) p.setHasAzureEmbedEndpoint(true);
                if (p.azureEmbedKey.trim()) p.setHasAzureEmbedKey(true);
                p.setAzureEmbedEndpoint('');
                p.setAzureEmbedKey('');
                p.setMessage({ type: 'success', text: 'Azure OpenAI embedding credentials saved' });
            }
        });
    };
    return (
        <SettingRow
            label={<span className="flex items-center gap-2">{t('integ.services_azure_openai_embeddings', 'Azure OpenAI Embeddings')}{p.hasAzureEmbedEndpoint && p.hasAzureEmbedKey && <StatusChip>{t('integ.services_connected', 'Connected')}</StatusChip>}</span>}
            hint={<>{t('integ.services_deploy_an_embedding_model_in_your', 'Deploy an embedding model in your')} <a href="https://oai.azure.com" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>{t('integ.services_azure_openai_studio', 'Azure OpenAI Studio')}</a>{t('integ.services_used_for_kb_document_embeddings_when', '. Used for KB document embeddings when Azure processing is enabled.')}</>}
            expanded={(
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-2 sm:flex-row">
                        <input type="text" value={p.azureEmbedEndpoint} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setAzureEmbedEndpoint(e.target.value)} placeholder={p.hasAzureEmbedEndpoint ? MASK : 'https://your-resource.openai.azure.com'} className={FIELD_INPUT} />
                        <input type="password" value={p.azureEmbedKey} onChange={(e: React.ChangeEvent<HTMLInputElement>) => p.setAzureEmbedKey(e.target.value)} placeholder={p.hasAzureEmbedKey ? MASK : 'API Key'} className={FIELD_INPUT} />
                        <SaveButton saving={p.savingAzureEmbed} disabled={empty} onClick={save}>{t('integ.services_save', 'Save')}</SaveButton>
                    </div>
                    <FieldGrid>
                        <Field label="Model" htmlFor="azure-embed-model">
                            <select id="azure-embed-model" value={p.azureEmbedModel} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => p.setAzureEmbedModel(e.target.value)} className={FIELD_INPUT}>
                                <option value="text-embedding-3-small">{t('integ.services_text_embedding_3_small_1536_dims', 'text-embedding-3-small (1536 dims)')}</option>
                                <option value="text-embedding-3-large">{t('integ.services_text_embedding_3_large_3072_dims', 'text-embedding-3-large (3072 dims)')}</option>
                                <option value="text-embedding-ada-002">{t('integ.services_text_embedding_ada_002_1536_dims', 'text-embedding-ada-002 (1536 dims)')}</option>
                            </select>
                        </Field>
                    </FieldGrid>
                </div>
            )}
        />
    );
}

function AzureGroup(p: ServicesSectionProps) {
    const { t } = useTranslation();
    const toggle = () => {
        const newVal = !p.useAzureDocProcessing;
        void runSave(p.setSavingAzureToggle, p.setMessage, 'Failed to update setting', async () => {
            if (await postConfig({ useAzureDocProcessing: newVal })) {
                p.setUseAzureDocProcessing(newVal);
                p.setMessage({ type: 'success', text: newVal ? 'Azure processing enabled for Knowledge Bases' : 'Switched to local processing for Knowledge Bases' });
            }
        });
    };
    return (
        <SettingsGroup
            title={<span className="flex items-center gap-2">{AZURE_LOGO}{t('integ.services_azure_document_processing', 'Azure Document Processing')}{p.hasAzureDocEndpoint && p.hasAzureDocKey && <StatusChip>{t('integ.services_configured', 'Configured')}</StatusChip>}</span>}
            description={t('integ.services_use_azure_ai_document_intelligence_for', 'Use Azure AI Document Intelligence for high-quality document extraction + Azure OpenAI for embeddings.')}
        >
            <SettingsList>
                <SettingRow inline
                    label={t('integ.services_use_azure_for_knowledge_bases', 'Use Azure for Knowledge Bases')}
                    hint={t('integ.services_all_file_uploads_will_use_azure', 'All file uploads will use Azure Document Intelligence + Azure OpenAI embeddings.')}
                >
                    <div className="flex justify-end">
                        <Toggle checked={p.useAzureDocProcessing} onChange={toggle} disabled={p.savingAzureToggle} ariaLabel={t('integ.services_use_azure_for_knowledge_bases', 'Use Azure for Knowledge Bases')} />
                    </div>
                </SettingRow>
                <AzureDocIntelligenceRow {...p} />
                <AzureEmbeddingsRow {...p} />
            </SettingsList>
        </SettingsGroup>
    );
}

export default function ServicesSection(props: ServicesSectionProps) {
    const { t } = useTranslation();
    return (
        <div className="flex max-w-4xl flex-col gap-8">
            <SectionHeader title={t('admin.integ_services')} description={t('integ.services_section_hint', 'Apps and cloud services that integrations and knowledge bases connect through.')} />
            <LinkedInGroup {...props} />
            <WithingsGroup {...props} />
            <AzureGroup {...props} />
        </div>
    );
}
