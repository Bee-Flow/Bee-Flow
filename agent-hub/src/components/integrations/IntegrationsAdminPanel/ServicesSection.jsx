// "Services" section of the IntegrationsAdminPanel (LinkedIn, Withings and
// Azure Document Processing credentials). Subtree moved verbatim from
// IntegrationsAdminPanel.jsx; all bindings are threaded in as props.
import { Check, Loader2 } from 'lucide-react';
import React from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';

export default function ServicesSection({
    linkedinClientId, setLinkedinClientId, linkedinClientSecret, setLinkedinClientSecret,
    hasLinkedInConfig, setHasLinkedInConfig, savingLinkedIn, setSavingLinkedIn,
    withingsClientId, setWithingsClientId, withingsClientSecret, setWithingsClientSecret,
    hasWithingsConfig, setHasWithingsConfig, savingWithings, setSavingWithings,
    azureDocEndpoint, setAzureDocEndpoint, azureDocKey, setAzureDocKey,
    hasAzureDocEndpoint, setHasAzureDocEndpoint, hasAzureDocKey, setHasAzureDocKey,
    savingAzureDoc, setSavingAzureDoc,
    azureEmbedEndpoint, setAzureEmbedEndpoint, azureEmbedKey, setAzureEmbedKey,
    azureEmbedModel, setAzureEmbedModel,
    hasAzureEmbedEndpoint, setHasAzureEmbedEndpoint, hasAzureEmbedKey, setHasAzureEmbedKey,
    savingAzureEmbed, setSavingAzureEmbed,
    useAzureDocProcessing, setUseAzureDocProcessing, savingAzureToggle, setSavingAzureToggle,
    setMessage,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-8">
                {/* LinkedIn Configuration */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="4" fill="#0A66C2" /><path d="M7.5 9.5h2v7h-2v-7zm1-3.2a1.2 1.2 0 110 2.4 1.2 1.2 0 010-2.4zm3.5 3.2h1.9v1h0c.27-.5 .92-1.1 1.9-1.1 2 0 2.4 1.3 2.4 3.1v3.6h-2v-3.2c0-.8 0-1.8-1.1-1.8s-1.3.9-1.3 1.7v3.3h-2v-6.6z" fill="white" /></svg>
                            {t('integ.services_linkedin_configuration', 'LinkedIn Configuration')}
                            {hasLinkedInConfig && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.services_configured', 'Configured')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.services_set_linkedin_api_credentials_users_can', 'Set LinkedIn API credentials. Users can then connect their LinkedIn accounts from Settings → Integrations.')}
                        </p>
                    </div>
                    <div className="p-6 space-y-3">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={linkedinClientId}
                                onChange={e => setLinkedinClientId(e.target.value)}
                                placeholder={hasLinkedInConfig ? '••••••••••••••••' : 'Client ID'}
                                className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <input
                                type="password"
                                value={linkedinClientSecret}
                                onChange={e => setLinkedinClientSecret(e.target.value)}
                                placeholder={hasLinkedInConfig ? '••••••••••••••••' : 'Client Secret'}
                                className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <button
                                onClick={async () => {
                                    if (!linkedinClientId.trim() || !linkedinClientSecret.trim()) return;
                                    setSavingLinkedIn(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ linkedinClientId, linkedinClientSecret }),
                                        });
                                        if (res.ok) {
                                            setHasLinkedInConfig(true);
                                            setLinkedinClientId('');
                                            setLinkedinClientSecret('');
                                            setMessage({ type: 'success', text: 'LinkedIn credentials saved' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save LinkedIn credentials' });
                                    }
                                    setSavingLinkedIn(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingLinkedIn || !linkedinClientId.trim() || !linkedinClientSecret.trim()}
                                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingLinkedIn ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {t('integ.services_save', 'Save')}
                            </button>
                        </div>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.services_get_credentials_from_your', 'Get credentials from your')} <a href="https://www.linkedin.com/developers/apps" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.services_linkedin_developer_app', 'LinkedIn Developer App')}</a> {t('integ.services_enable_share_on_linkedin_sign_in_with', '— enable "Share on LinkedIn" + "Sign In with LinkedIn using OpenID Connect".')}
                        </p>
                    </div>
                </div>

                {/* Withings Configuration */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="20" height="20" rx="4" fill="#00A9A6" /><path d="M5 12.5h3l1.6-3.4 2.3 6 1.7-3.6H19" stroke="white" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            {t('integ.services_withings_configuration', 'Withings Configuration')}
                            {hasWithingsConfig && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.services_configured', 'Configured')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.services_set_withings_api_credentials_users_can', 'Set Withings API credentials. Users can then connect their Health Mate accounts from Settings → Integrations.')}
                        </p>
                    </div>
                    <div className="p-6 space-y-3">
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={withingsClientId}
                                onChange={e => setWithingsClientId(e.target.value)}
                                placeholder={hasWithingsConfig ? '••••••••••••••••' : 'Client ID'}
                                className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <input
                                type="password"
                                value={withingsClientSecret}
                                onChange={e => setWithingsClientSecret(e.target.value)}
                                placeholder={hasWithingsConfig ? '••••••••••••••••' : 'Client Secret'}
                                className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <button
                                onClick={async () => {
                                    if (!withingsClientId.trim() || !withingsClientSecret.trim()) return;
                                    setSavingWithings(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ withingsClientId, withingsClientSecret }),
                                        });
                                        if (res.ok) {
                                            setHasWithingsConfig(true);
                                            setWithingsClientId('');
                                            setWithingsClientSecret('');
                                            setMessage({ type: 'success', text: 'Withings credentials saved' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save Withings credentials' });
                                    }
                                    setSavingWithings(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingWithings || !withingsClientId.trim() || !withingsClientSecret.trim()}
                                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingWithings ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {t('integ.services_save', 'Save')}
                            </button>
                        </div>
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.services_register_an_app_in_the', 'Register an app in the')} <a href="https://developer.withings.com/dashboard/" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.services_withings_developer_dashboard', 'Withings Developer Dashboard')}</a> {t('integ.services_and_set_its_callback_url_to', 'and set its callback URL to')} <code>{`${window.location.origin}/api/integrations/withings/callback`}</code>{t('integ.services_withings_requires_an_https_callback_so', '. Withings requires an HTTPS callback, so a local deployment needs a tunnel.')}
                        </p>
                    </div>
                </div>

                {/* Azure Document Processing */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 2L2 7l10 5 10-5-10-5z" fill="#0078D4"/><path d="M2 17l10 5 10-5" stroke="#0078D4" strokeWidth="2" fill="none"/><path d="M2 12l10 5 10-5" stroke="#50A0E0" strokeWidth="2" fill="none"/></svg>
                            {t('integ.services_azure_document_processing', 'Azure Document Processing')}
                            {(hasAzureDocEndpoint && hasAzureDocKey) && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.services_configured', 'Configured')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                            {t('integ.services_use_azure_ai_document_intelligence_for', 'Use Azure AI Document Intelligence for high-quality document extraction + Azure OpenAI for embeddings.')}
                        </p>
                    </div>
                    <div className="p-6 space-y-5">
                        {/* Global toggle */}
                        <div className="flex items-center justify-between p-3 rounded-xl border" style={{ background: 'var(--bg-primary)', borderColor: useAzureDocProcessing ? 'rgba(59,130,246,0.3)' : 'var(--border-subtle)' }}>
                            <div className="flex items-center gap-3">
                                <span className="text-lg">☁️</span>
                                <div>
                                    <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('integ.services_use_azure_for_knowledge_bases', 'Use Azure for Knowledge Bases')}</div>
                                    <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{t('integ.services_all_file_uploads_will_use_azure', 'All file uploads will use Azure Document Intelligence + Azure OpenAI embeddings.')}</div>
                                </div>
                            </div>
                            <button
                                onClick={async () => {
                                    const newVal = !useAzureDocProcessing;
                                    setSavingAzureToggle(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ useAzureDocProcessing: newVal }),
                                        });
                                        if (res.ok) {
                                            setUseAzureDocProcessing(newVal);
                                            setMessage({ type: 'success', text: newVal ? 'Azure processing enabled for Knowledge Bases' : 'Switched to local processing for Knowledge Bases' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to update setting' });
                                    }
                                    setSavingAzureToggle(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingAzureToggle}
                                className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${useAzureDocProcessing ? 'bg-blue-500' : 'bg-gray-600'}`}
                            >
                                <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${useAzureDocProcessing ? 'left-6' : 'left-1'}`} />
                            </button>
                        </div>
                        {/* Document Intelligence */}
                        <div>
                            <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                {t('integ.services_document_intelligence', 'Document Intelligence')}
                                {(hasAzureDocEndpoint && hasAzureDocKey) && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.services_connected', 'Connected')}</span>}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={azureDocEndpoint}
                                    onChange={e => setAzureDocEndpoint(e.target.value)}
                                    placeholder={hasAzureDocEndpoint ? '••••••••••••••••' : 'https://your-resource.cognitiveservices.azure.com'}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                />
                                <input
                                    type="password"
                                    value={azureDocKey}
                                    onChange={e => setAzureDocKey(e.target.value)}
                                    placeholder={hasAzureDocKey ? '••••••••••••••••' : 'API Key'}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                />
                                <button
                                    onClick={async () => {
                                        if (!azureDocEndpoint.trim() && !azureDocKey.trim()) return;
                                        setSavingAzureDoc(true);
                                        try {
                                            const body = {};
                                            if (azureDocEndpoint.trim()) body.azureDocIntelligenceEndpoint = azureDocEndpoint;
                                            if (azureDocKey.trim()) body.azureDocIntelligenceKey = azureDocKey;
                                            const res = await authFetch(`${API_BASE}/ai/config`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(body),
                                            });
                                            if (res.ok) {
                                                if (azureDocEndpoint.trim()) setHasAzureDocEndpoint(true);
                                                if (azureDocKey.trim()) setHasAzureDocKey(true);
                                                setAzureDocEndpoint('');
                                                setAzureDocKey('');
                                                setMessage({ type: 'success', text: 'Document Intelligence credentials saved' });
                                            }
                                        } catch (e) {
                                            setMessage({ type: 'error', text: 'Failed to save credentials' });
                                        }
                                        setSavingAzureDoc(false);
                                        setTimeout(() => setMessage(null), 3000);
                                    }}
                                    disabled={savingAzureDoc || (!azureDocEndpoint.trim() && !azureDocKey.trim())}
                                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                    style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                >
                                    {savingAzureDoc ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                    {t('integ.services_save', 'Save')}
                                </button>
                            </div>
                            <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.services_create_a_resource_at', 'Create a resource at')} <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesFormRecognizer" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.services_azure_portal_ai_document_intelligence', 'Azure Portal → AI Document Intelligence')}</a>.
                            </p>
                        </div>

                        {/* Azure OpenAI Embeddings */}
                        <div className="pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                            <label className="text-sm font-medium flex items-center gap-2 mb-2" style={{ color: 'var(--text-primary)' }}>
                                {t('integ.services_azure_openai_embeddings', 'Azure OpenAI Embeddings')}
                                {(hasAzureEmbedEndpoint && hasAzureEmbedKey) && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.services_connected', 'Connected')}</span>}
                            </label>
                            <div className="flex gap-2 mb-2">
                                <input
                                    type="text"
                                    value={azureEmbedEndpoint}
                                    onChange={e => setAzureEmbedEndpoint(e.target.value)}
                                    placeholder={hasAzureEmbedEndpoint ? '••••••••••••••••' : 'https://your-resource.openai.azure.com'}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                />
                                <input
                                    type="password"
                                    value={azureEmbedKey}
                                    onChange={e => setAzureEmbedKey(e.target.value)}
                                    placeholder={hasAzureEmbedKey ? '••••••••••••••••' : 'API Key'}
                                    className="flex-1 px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                />
                                <button
                                    onClick={async () => {
                                        if (!azureEmbedEndpoint.trim() && !azureEmbedKey.trim()) return;
                                        setSavingAzureEmbed(true);
                                        try {
                                            const body = { azureOpenaiEmbeddingModel: azureEmbedModel };
                                            if (azureEmbedEndpoint.trim()) body.azureOpenaiEmbeddingEndpoint = azureEmbedEndpoint;
                                            if (azureEmbedKey.trim()) body.azureOpenaiEmbeddingKey = azureEmbedKey;
                                            const res = await authFetch(`${API_BASE}/ai/config`, {
                                                method: 'POST',
                                                headers: { 'Content-Type': 'application/json' },
                                                body: JSON.stringify(body),
                                            });
                                            if (res.ok) {
                                                if (azureEmbedEndpoint.trim()) setHasAzureEmbedEndpoint(true);
                                                if (azureEmbedKey.trim()) setHasAzureEmbedKey(true);
                                                setAzureEmbedEndpoint('');
                                                setAzureEmbedKey('');
                                                setMessage({ type: 'success', text: 'Azure OpenAI embedding credentials saved' });
                                            }
                                        } catch (e) {
                                            setMessage({ type: 'error', text: 'Failed to save credentials' });
                                        }
                                        setSavingAzureEmbed(false);
                                        setTimeout(() => setMessage(null), 3000);
                                    }}
                                    disabled={savingAzureEmbed || (!azureEmbedEndpoint.trim() && !azureEmbedKey.trim())}
                                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                    style={{ background: 'var(--accent-primary)', color: '#fff' }}
                                >
                                    {savingAzureEmbed ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                    {t('integ.services_save', 'Save')}
                                </button>
                            </div>
                            <div className="flex gap-2 items-center">
                                <label className="text-xs" style={{ color: 'var(--text-muted)' }}>Model:</label>
                                <select
                                    value={azureEmbedModel}
                                    onChange={e => setAzureEmbedModel(e.target.value)}
                                    className="px-3 py-1.5 rounded-lg text-sm border outline-none"
                                    style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                >
                                    <option value="text-embedding-3-small">{t('integ.services_text_embedding_3_small_1536_dims', 'text-embedding-3-small (1536 dims)')}</option>
                                    <option value="text-embedding-3-large">{t('integ.services_text_embedding_3_large_3072_dims', 'text-embedding-3-large (3072 dims)')}</option>
                                    <option value="text-embedding-ada-002">{t('integ.services_text_embedding_ada_002_1536_dims', 'text-embedding-ada-002 (1536 dims)')}</option>
                                </select>
                            </div>
                            <p className="text-xs mt-1.5" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.services_deploy_an_embedding_model_in_your', 'Deploy an embedding model in your')} <a href="https://oai.azure.com" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.services_azure_openai_studio', 'Azure OpenAI Studio')}</a>{t('integ.services_used_for_kb_document_embeddings_when', '. Used for KB document embeddings when Azure processing is enabled.')}
                            </p>
                        </div>
                    </div>
                </div>


            </div>
            </div>
    );
}
