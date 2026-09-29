// State core of the IntegrationsAdminPanel — every useState plus the initial
// load() effect, moved verbatim from IntegrationsAdminPanel.jsx. Called first
// in the panel so all state stays owned by the panel's fiber; the panel, the
// other panel hooks and the section components receive these bindings by
// explicit threading.
import { useEffect, useState } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';

export default function useIntegrationsAdminState() {
    const [defaults, setDefaults] = useState(null); // null = all enabled
    const [organizations, setOrganizations] = useState([]);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState(null);
    const [agentSearchUrl, setAgentSearchUrl] = useState('');
    const [hasAgentSearchUrl, setHasAgentSearchUrl] = useState(false);
    const [savingSearchUrl, setSavingSearchUrl] = useState(false);
    const [serperApiKey, setSerperApiKey] = useState('');
    const [hasSerperKey, setHasSerperKey] = useState(false);
    const [savingSerperKey, setSavingSerperKey] = useState(false);
    const [searchProvider, setSearchProvider] = useState('agent-search');
    const [bingSearchKey, setBingSearchKey] = useState('');
    const [hasBingSearchKey, setHasBingSearchKey] = useState(false);
    const [bingSearchMarket, setBingSearchMarket] = useState('');
    const [savingBingKey, setSavingBingKey] = useState(false);
    const [agentSearchDefaults, setAgentSearchDefaults] = useState({
        mode: 'web', include_citations: true,
        web: { max_results: 5, fetch_top_n: 3, max_tokens_markdown: 2000 },
        web_fast: { max_results: 10, max_tokens_markdown: 1500 },
    });
    const [savingSearchDefaults, setSavingSearchDefaults] = useState(false);
    const [linkedinClientId, setLinkedinClientId] = useState('');
    const [linkedinClientSecret, setLinkedinClientSecret] = useState('');
    const [hasLinkedInConfig, setHasLinkedInConfig] = useState(false);
    const [savingLinkedIn, setSavingLinkedIn] = useState(false);
    const [withingsClientId, setWithingsClientId] = useState('');
    const [withingsClientSecret, setWithingsClientSecret] = useState('');
    const [hasWithingsConfig, setHasWithingsConfig] = useState(false);
    const [savingWithings, setSavingWithings] = useState(false);
    // Azure Document Intelligence + Azure OpenAI Embeddings
    const [azureDocEndpoint, setAzureDocEndpoint] = useState('');
    const [azureDocKey, setAzureDocKey] = useState('');
    const [hasAzureDocEndpoint, setHasAzureDocEndpoint] = useState(false);
    const [hasAzureDocKey, setHasAzureDocKey] = useState(false);
    const [savingAzureDoc, setSavingAzureDoc] = useState(false);
    const [azureEmbedEndpoint, setAzureEmbedEndpoint] = useState('');
    const [azureEmbedKey, setAzureEmbedKey] = useState('');
    const [azureEmbedModel, setAzureEmbedModel] = useState('text-embedding-3-small');
    const [hasAzureEmbedEndpoint, setHasAzureEmbedEndpoint] = useState(false);
    const [hasAzureEmbedKey, setHasAzureEmbedKey] = useState(false);
    const [savingAzureEmbed, setSavingAzureEmbed] = useState(false);
    const [useAzureDocProcessing, setUseAzureDocProcessing] = useState(false);
    const [savingAzureToggle, setSavingAzureToggle] = useState(false);
    // Azure AI Speech (Meeting Transcription)
    const [azureSpeechKey, setAzureSpeechKey] = useState('');
    const [azureSpeechRegion, setAzureSpeechRegion] = useState('');
    const [hasAzureSpeechKey, setHasAzureSpeechKey] = useState(false);
    const [savingAzureSpeech, setSavingAzureSpeech] = useState(false);
    const [transcriptionProvider, setTranscriptionProvider] = useState('voxtral');
    const [savingTranscriptionProvider, setSavingTranscriptionProvider] = useState(false);
    // WhisperX self-hosted
    const [whisperxUrl, setWhisperxUrl] = useState('');
    const [whisperxToken, setWhisperxToken] = useState('');
    const [hasWhisperxUrl, setHasWhisperxUrl] = useState(false);
    const [hasWhisperxToken, setHasWhisperxToken] = useState(false);
    const [savingWhisperx, setSavingWhisperx] = useState(false);
    // Scaleway Whisper (hybrid: cloud transcription + local diarization)
    const [scalewayApiKey, setScalewayApiKey] = useState('');
    const [hasScalewayKey, setHasScalewayKey] = useState(false);
    const [savingScaleway, setSavingScaleway] = useState(false);
    // pyannoteAI (all-in-one diarization + transcription)
    const [pyannoteApiKey, setPyannoteApiKey] = useState('');
    const [hasPyannoteKey, setHasPyannoteKey] = useState(false);
    const [savingPyannote, setSavingPyannote] = useState(false);
    // '' = automatic (best model per meeting language); otherwise a pinned model.
    const [pyannoteTranscriptionModel, setPyannoteTranscriptionModel] = useState('');
    const [savingPyannoteModel, setSavingPyannoteModel] = useState(false);
    // Per-person voiceprint speaker identification (pyannote only)
    const [voiceprintMatchingEnabled, setVoiceprintMatchingEnabled] = useState(true);
    const [pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold] = useState(50);
    const [savingVoiceprint, setSavingVoiceprint] = useState(false);

    // Service Email (Gmail API via OAuth)
    const [serviceEmailAddress, setServiceEmailAddress] = useState(''); // connected account (read-only)
    const [serviceEmailDisplayName, setServiceEmailDisplayName] = useState('');
    const [hasServiceEmail, setHasServiceEmail] = useState(false);
    const [savingServiceEmail, setSavingServiceEmail] = useState(false);
    const [connectingServiceEmail, setConnectingServiceEmail] = useState(false);
    const [testingServiceEmail, setTestingServiceEmail] = useState(false);
    const [testEmailRecipient, setTestEmailRecipient] = useState('');
    const [showTestEmail, setShowTestEmail] = useState(false);

    // MCP servers — kept only to surface installed servers as integrations in
    // the Global Defaults list below. Install/config + per-group MCP access now
    // live in the Access & Permissions hub.
    const [mcpServers, setMcpServers] = useState([]);

    useEffect(() => {
        load();
    }, []);

    const load = async () => {
        setLoading(true);
        try {
            const [defRes, orgsRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/default-integrations`),
                authFetch(`${API_BASE}/auth/organizations`),
            ]);
            if (defRes.ok) {
                const data = await defRes.json();
                setDefaults(data.defaults);
            }
            if (orgsRes.ok) {
                const orgs = await orgsRes.json();
                setOrganizations(orgs);
            }
        } catch (e) { console.error(e); }
        // Load config status
        try {
            const configRes = await authFetch(`${API_BASE}/ai/config`);
            if (configRes.ok) {
                const configData = await configRes.json();
                setHasAgentSearchUrl(!!configData.hasAgentSearchUrl);
                if (configData.agentSearchUrl) setAgentSearchUrl(configData.agentSearchUrl);
                setHasLinkedInConfig(!!configData.hasLinkedInConfig);
                setHasWithingsConfig(!!configData.hasWithingsConfig);
                setHasSerperKey(!!configData.hasSerperKey);
                setSearchProvider(configData.searchProvider || 'agent-search');
                setHasBingSearchKey(!!configData.hasBingSearchKey);
                if (configData.bingSearchMarket) setBingSearchMarket(configData.bingSearchMarket);
                // Azure Document Intelligence
                setHasAzureDocEndpoint(!!configData.hasAzureDocIntelligenceEndpoint);
                setHasAzureDocKey(!!configData.hasAzureDocIntelligenceKey);
                // Azure OpenAI Embeddings
                setHasAzureEmbedEndpoint(!!configData.hasAzureOpenaiEmbeddingEndpoint);
                setHasAzureEmbedKey(!!configData.hasAzureOpenaiEmbeddingKey);
                if (configData.azureOpenaiEmbeddingModel) setAzureEmbedModel(configData.azureOpenaiEmbeddingModel);
                setUseAzureDocProcessing(!!configData.useAzureDocProcessing);
                // Azure AI Speech
                setHasAzureSpeechKey(!!configData.hasAzureSpeechKey);
                if (configData.azureSpeechRegion) setAzureSpeechRegion(configData.azureSpeechRegion);
                setTranscriptionProvider(configData.transcriptionProvider || 'voxtral');
                // WhisperX
                setHasWhisperxUrl(!!configData.hasWhisperxUrl);
                setHasWhisperxToken(!!configData.hasWhisperxToken);
                // Scaleway (hybrid)
                setHasScalewayKey(!!configData.hasScalewayKey);
                // pyannoteAI
                setHasPyannoteKey(!!configData.hasPyannoteKey);
                setPyannoteTranscriptionModel(configData.pyannoteTranscriptionModel || '');
                setVoiceprintMatchingEnabled(configData.voiceprintMatchingEnabled !== false);
                if (configData.pyannoteIdentifyThreshold != null) setPyannoteIdentifyThreshold(configData.pyannoteIdentifyThreshold);
                // Service Email
                setHasServiceEmail(!!configData.hasServiceEmail);
                if (configData.serviceEmailAddress) setServiceEmailAddress(configData.serviceEmailAddress);
                if (configData.serviceEmailDisplayName) setServiceEmailDisplayName(configData.serviceEmailDisplayName);
            }
        } catch (e) { console.error(e); }
        try {
            const searchDefRes = await authFetch(`${API_BASE}/ai/agent-search/defaults`);
            if (searchDefRes.ok) {
                const d = await searchDefRes.json();
                setAgentSearchDefaults(prev => ({ ...prev, ...d }));
            }
        } catch (e) { console.error(e); }
        // Load MCP servers
        try {
            const mcpRes = await authFetch(`${API_BASE}/ai/mcp-servers`);
            if (mcpRes.ok) {
                const mcpData = await mcpRes.json();
                setMcpServers(mcpData.servers || []);
            }
        } catch (e) { console.error(e); }
        setLoading(false);
    };

    return {
        defaults, setDefaults,
        organizations, setOrganizations,
        loading, setLoading,
        saving, setSaving,
        message, setMessage,
        agentSearchUrl, setAgentSearchUrl,
        hasAgentSearchUrl, setHasAgentSearchUrl,
        savingSearchUrl, setSavingSearchUrl,
        serperApiKey, setSerperApiKey,
        hasSerperKey, setHasSerperKey,
        savingSerperKey, setSavingSerperKey,
        searchProvider, setSearchProvider,
        bingSearchKey, setBingSearchKey,
        hasBingSearchKey, setHasBingSearchKey,
        bingSearchMarket, setBingSearchMarket,
        savingBingKey, setSavingBingKey,
        agentSearchDefaults, setAgentSearchDefaults,
        savingSearchDefaults, setSavingSearchDefaults,
        linkedinClientId, setLinkedinClientId,
        linkedinClientSecret, setLinkedinClientSecret,
        hasLinkedInConfig, setHasLinkedInConfig,
        savingLinkedIn, setSavingLinkedIn,
        withingsClientId, setWithingsClientId,
        withingsClientSecret, setWithingsClientSecret,
        hasWithingsConfig, setHasWithingsConfig,
        savingWithings, setSavingWithings,
        azureDocEndpoint, setAzureDocEndpoint,
        azureDocKey, setAzureDocKey,
        hasAzureDocEndpoint, setHasAzureDocEndpoint,
        hasAzureDocKey, setHasAzureDocKey,
        savingAzureDoc, setSavingAzureDoc,
        azureEmbedEndpoint, setAzureEmbedEndpoint,
        azureEmbedKey, setAzureEmbedKey,
        azureEmbedModel, setAzureEmbedModel,
        hasAzureEmbedEndpoint, setHasAzureEmbedEndpoint,
        hasAzureEmbedKey, setHasAzureEmbedKey,
        savingAzureEmbed, setSavingAzureEmbed,
        useAzureDocProcessing, setUseAzureDocProcessing,
        savingAzureToggle, setSavingAzureToggle,
        azureSpeechKey, setAzureSpeechKey,
        azureSpeechRegion, setAzureSpeechRegion,
        hasAzureSpeechKey, setHasAzureSpeechKey,
        savingAzureSpeech, setSavingAzureSpeech,
        transcriptionProvider, setTranscriptionProvider,
        savingTranscriptionProvider, setSavingTranscriptionProvider,
        whisperxUrl, setWhisperxUrl,
        whisperxToken, setWhisperxToken,
        hasWhisperxUrl, setHasWhisperxUrl,
        hasWhisperxToken, setHasWhisperxToken,
        savingWhisperx, setSavingWhisperx,
        scalewayApiKey, setScalewayApiKey,
        hasScalewayKey, setHasScalewayKey,
        savingScaleway, setSavingScaleway,
        pyannoteApiKey, setPyannoteApiKey,
        hasPyannoteKey, setHasPyannoteKey,
        savingPyannote, setSavingPyannote,
        pyannoteTranscriptionModel, setPyannoteTranscriptionModel,
        savingPyannoteModel, setSavingPyannoteModel,
        voiceprintMatchingEnabled, setVoiceprintMatchingEnabled,
        pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold,
        savingVoiceprint, setSavingVoiceprint,
        serviceEmailAddress, setServiceEmailAddress,
        serviceEmailDisplayName, setServiceEmailDisplayName,
        hasServiceEmail, setHasServiceEmail,
        savingServiceEmail, setSavingServiceEmail,
        connectingServiceEmail, setConnectingServiceEmail,
        testingServiceEmail, setTestingServiceEmail,
        testEmailRecipient, setTestEmailRecipient,
        showTestEmail, setShowTestEmail,
        mcpServers, setMcpServers,
        load,
    };
}
