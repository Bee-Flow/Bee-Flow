import { Loader2 } from 'lucide-react';
import React from 'react';
import FeatureKillSwitches from './FeatureKillSwitches';
import { useLicenseContext } from '../licensing/LicenseContext';
import EmailSection from './IntegrationsAdminPanel/EmailSection';
import GlobalDefaultsSection from './IntegrationsAdminPanel/GlobalDefaultsSection';
import SearchSection from './IntegrationsAdminPanel/SearchSection';
import { SECTIONS, SECTION_FEATURE_GATE, ENTERPRISE_ONLY_SECTIONS } from './IntegrationsAdminPanel/sections';
import ServicesSection from './IntegrationsAdminPanel/ServicesSection';
import TranscriptionSection from './IntegrationsAdminPanel/TranscriptionSection';
import useIntegrationDefaults from './IntegrationsAdminPanel/useIntegrationDefaults';
import useIntegrationsAdminState from './IntegrationsAdminPanel/useIntegrationsAdminState';
import useServiceEmailActions from './IntegrationsAdminPanel/useServiceEmailActions';
import useTranscriptionSettings from './IntegrationsAdminPanel/useTranscriptionSettings';
import { useTranslation } from '../../hooks/useTranslation';

export default function IntegrationsAdminPanel({ activeSection: activeProp = 'features', onNavigate }) {
    const { t } = useTranslation();
    const { hasFeature, hasTier } = useLicenseContext();
    const isEnterprise = hasTier('enterprise');
    // Hide enterprise-gated sections on Community. A deep link to a hidden
    // section (or a tier downgrade) falls back to the always-visible Features
    // section so the enterprise panel never renders.
    const visibleSections = SECTIONS.filter(
        s => (!SECTION_FEATURE_GATE[s.id] || hasFeature(SECTION_FEATURE_GATE[s.id]))
            && (!ENTERPRISE_ONLY_SECTIONS.has(s.id) || isEnterprise)
    );
    const active = visibleSections.map(s => s.id).includes(activeProp) ? activeProp : 'features';
    // The MCP marketplace moved to Settings → Organisation → MCP library
    // (its "Server-wide" tab for server administrators). An old link or
    // bookmark to admin/integrations/mcp lands there instead of on Features.
    React.useEffect(() => {
        if (activeProp === 'mcp' && onNavigate) onNavigate('settings/organisation/mcp');
    }, [activeProp, onNavigate]);
    const handleSectionClick = (id) => {
        if (onNavigate) onNavigate(`admin/integrations/${id}`);
    };
    const state = useIntegrationsAdminState();
    const {
        defaults, setDefaults,
        loading,
        setSaving,
        message, setMessage,
        agentSearchUrl,
        hasAgentSearchUrl,
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
        mcpServers,
        load,
    } = state;

    const { saveTranscriptionModel, saveVoiceprintSettings } = useTranscriptionSettings({
        pyannoteTranscriptionModel, setPyannoteTranscriptionModel, setSavingPyannoteModel,
        voiceprintMatchingEnabled, setVoiceprintMatchingEnabled,
        pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold, setSavingVoiceprint,
        setMessage,
    });

    const { startServiceEmailConnect, disconnectServiceEmail, saveServiceEmailDisplayName } = useServiceEmailActions({
        setConnectingServiceEmail, setHasServiceEmail, setServiceEmailAddress, load,
        setSavingServiceEmail, setShowTestEmail, serviceEmailDisplayName,
        setMessage,
    });

    const {
        allIntegrations, isDefaultEnabled, toggleDefault,
        enableAllDefaults, disableAllDefaults, categories,
    } = useIntegrationDefaults({ defaults, setDefaults, setSaving, setMessage, mcpServers });

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full" style={{ color: 'var(--text-muted)' }}>
                <Loader2 className="w-6 h-6 animate-spin mr-2" /> Loading integrations...
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>
            {/* ── Left Sidebar ── */}
            <div style={{
                width: '56px',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: '2px',
                padding: '8px 0',
                background: 'var(--bg-secondary, #111)',
                borderRight: '1px solid var(--border-default, rgba(255,255,255,0.08))',
            }}>
                {visibleSections.map(sec => {
                    const Icon = sec.icon;
                    const isActive = active === sec.id;
                    return (
                        <button
                            key={sec.id}
                            onClick={() => handleSectionClick(sec.id)}
                            title={t(sec.labelKey)}
                            style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'center',
                                gap: '3px',
                                padding: '10px 4px',
                                margin: '0 4px',
                                borderRadius: '8px',
                                border: 'none',
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                background: isActive ? `${sec.color}20` : 'transparent',
                                borderLeft: isActive ? `3px solid ${sec.color}` : '3px solid transparent',
                            }}
                        >
                            <Icon style={{
                                width: 20, height: 20,
                                color: isActive ? sec.color : 'var(--text-muted, #888)',
                                transition: 'color 0.15s ease',
                            }} />
                            <span style={{
                                fontSize: '9px',
                                fontWeight: isActive ? '700' : '500',
                                color: isActive ? sec.color : 'var(--text-muted, #888)',
                                textAlign: 'center',
                                lineHeight: 1.1,
                                transition: 'color 0.15s ease',
                            }}>
                                {t(sec.labelKey)}
                            </span>
                        </button>
                    );
                })}
            </div>

            {/* ── Main Content Panel ── */}
            <div style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
            {/* Status message toast */}
            {message && (
                <div style={{ position: 'sticky', top: 0, zIndex: 10, padding: '8px 24px' }}>
                    <span className={`text-sm font-medium px-3 py-1.5 rounded-lg inline-block ${message.type === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'}`}>
                        {message.text}
                    </span>
                </div>
            )}

            {active === 'features' && (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-8">

                <FeatureKillSwitches />

            </div>
            </div>
            )}

            {active === 'integrations' && (
                <GlobalDefaultsSection
                    enableAllDefaults={enableAllDefaults}
                    disableAllDefaults={disableAllDefaults}
                    categories={categories}
                    allIntegrations={allIntegrations}
                    isDefaultEnabled={isDefaultEnabled}
                    toggleDefault={toggleDefault}
                />
            )}

            {active === 'email' && (
                <EmailSection
                    hasServiceEmail={hasServiceEmail}
                    serviceEmailAddress={serviceEmailAddress}
                    disconnectServiceEmail={disconnectServiceEmail}
                    savingServiceEmail={savingServiceEmail}
                    serviceEmailDisplayName={serviceEmailDisplayName}
                    setServiceEmailDisplayName={setServiceEmailDisplayName}
                    saveServiceEmailDisplayName={saveServiceEmailDisplayName}
                    showTestEmail={showTestEmail}
                    setShowTestEmail={setShowTestEmail}
                    startServiceEmailConnect={startServiceEmailConnect}
                    connectingServiceEmail={connectingServiceEmail}
                    testEmailRecipient={testEmailRecipient}
                    setTestEmailRecipient={setTestEmailRecipient}
                    testingServiceEmail={testingServiceEmail}
                    setTestingServiceEmail={setTestingServiceEmail}
                    setMessage={setMessage}
                />
            )}

            {active === 'services' && (
                <ServicesSection
                    linkedinClientId={linkedinClientId}
                    setLinkedinClientId={setLinkedinClientId}
                    linkedinClientSecret={linkedinClientSecret}
                    setLinkedinClientSecret={setLinkedinClientSecret}
                    hasLinkedInConfig={hasLinkedInConfig}
                    setHasLinkedInConfig={setHasLinkedInConfig}
                    savingLinkedIn={savingLinkedIn}
                    setSavingLinkedIn={setSavingLinkedIn}
                    withingsClientId={withingsClientId}
                    setWithingsClientId={setWithingsClientId}
                    withingsClientSecret={withingsClientSecret}
                    setWithingsClientSecret={setWithingsClientSecret}
                    hasWithingsConfig={hasWithingsConfig}
                    setHasWithingsConfig={setHasWithingsConfig}
                    savingWithings={savingWithings}
                    setSavingWithings={setSavingWithings}
                    azureDocEndpoint={azureDocEndpoint}
                    setAzureDocEndpoint={setAzureDocEndpoint}
                    azureDocKey={azureDocKey}
                    setAzureDocKey={setAzureDocKey}
                    hasAzureDocEndpoint={hasAzureDocEndpoint}
                    setHasAzureDocEndpoint={setHasAzureDocEndpoint}
                    hasAzureDocKey={hasAzureDocKey}
                    setHasAzureDocKey={setHasAzureDocKey}
                    savingAzureDoc={savingAzureDoc}
                    setSavingAzureDoc={setSavingAzureDoc}
                    azureEmbedEndpoint={azureEmbedEndpoint}
                    setAzureEmbedEndpoint={setAzureEmbedEndpoint}
                    azureEmbedKey={azureEmbedKey}
                    setAzureEmbedKey={setAzureEmbedKey}
                    azureEmbedModel={azureEmbedModel}
                    setAzureEmbedModel={setAzureEmbedModel}
                    hasAzureEmbedEndpoint={hasAzureEmbedEndpoint}
                    setHasAzureEmbedEndpoint={setHasAzureEmbedEndpoint}
                    hasAzureEmbedKey={hasAzureEmbedKey}
                    setHasAzureEmbedKey={setHasAzureEmbedKey}
                    savingAzureEmbed={savingAzureEmbed}
                    setSavingAzureEmbed={setSavingAzureEmbed}
                    useAzureDocProcessing={useAzureDocProcessing}
                    setUseAzureDocProcessing={setUseAzureDocProcessing}
                    savingAzureToggle={savingAzureToggle}
                    setSavingAzureToggle={setSavingAzureToggle}
                    setMessage={setMessage}
                />
            )}

            {active === 'search' && (
                <SearchSection
                    searchProvider={searchProvider}
                    setSearchProvider={setSearchProvider}
                    bingSearchKey={bingSearchKey}
                    setBingSearchKey={setBingSearchKey}
                    hasBingSearchKey={hasBingSearchKey}
                    setHasBingSearchKey={setHasBingSearchKey}
                    bingSearchMarket={bingSearchMarket}
                    setBingSearchMarket={setBingSearchMarket}
                    savingBingKey={savingBingKey}
                    setSavingBingKey={setSavingBingKey}
                    agentSearchUrl={agentSearchUrl}
                    hasAgentSearchUrl={hasAgentSearchUrl}
                    serperApiKey={serperApiKey}
                    setSerperApiKey={setSerperApiKey}
                    hasSerperKey={hasSerperKey}
                    setHasSerperKey={setHasSerperKey}
                    savingSerperKey={savingSerperKey}
                    setSavingSerperKey={setSavingSerperKey}
                    agentSearchDefaults={agentSearchDefaults}
                    setAgentSearchDefaults={setAgentSearchDefaults}
                    savingSearchDefaults={savingSearchDefaults}
                    setSavingSearchDefaults={setSavingSearchDefaults}
                    setMessage={setMessage}
                />
            )}

            {active === 'transcription' && (
                <TranscriptionSection
                    transcriptionProvider={transcriptionProvider}
                    setTranscriptionProvider={setTranscriptionProvider}
                    savingTranscriptionProvider={savingTranscriptionProvider}
                    setSavingTranscriptionProvider={setSavingTranscriptionProvider}
                    hasAzureSpeechKey={hasAzureSpeechKey}
                    setHasAzureSpeechKey={setHasAzureSpeechKey}
                    azureSpeechKey={azureSpeechKey}
                    setAzureSpeechKey={setAzureSpeechKey}
                    azureSpeechRegion={azureSpeechRegion}
                    setAzureSpeechRegion={setAzureSpeechRegion}
                    savingAzureSpeech={savingAzureSpeech}
                    setSavingAzureSpeech={setSavingAzureSpeech}
                    whisperxUrl={whisperxUrl}
                    setWhisperxUrl={setWhisperxUrl}
                    whisperxToken={whisperxToken}
                    setWhisperxToken={setWhisperxToken}
                    hasWhisperxUrl={hasWhisperxUrl}
                    setHasWhisperxUrl={setHasWhisperxUrl}
                    hasWhisperxToken={hasWhisperxToken}
                    setHasWhisperxToken={setHasWhisperxToken}
                    savingWhisperx={savingWhisperx}
                    setSavingWhisperx={setSavingWhisperx}
                    scalewayApiKey={scalewayApiKey}
                    setScalewayApiKey={setScalewayApiKey}
                    hasScalewayKey={hasScalewayKey}
                    setHasScalewayKey={setHasScalewayKey}
                    savingScaleway={savingScaleway}
                    setSavingScaleway={setSavingScaleway}
                    pyannoteApiKey={pyannoteApiKey}
                    setPyannoteApiKey={setPyannoteApiKey}
                    hasPyannoteKey={hasPyannoteKey}
                    setHasPyannoteKey={setHasPyannoteKey}
                    savingPyannote={savingPyannote}
                    setSavingPyannote={setSavingPyannote}
                    pyannoteTranscriptionModel={pyannoteTranscriptionModel}
                    saveTranscriptionModel={saveTranscriptionModel}
                    savingPyannoteModel={savingPyannoteModel}
                    voiceprintMatchingEnabled={voiceprintMatchingEnabled}
                    saveVoiceprintSettings={saveVoiceprintSettings}
                    savingVoiceprint={savingVoiceprint}
                    pyannoteIdentifyThreshold={pyannoteIdentifyThreshold}
                    setPyannoteIdentifyThreshold={setPyannoteIdentifyThreshold}
                    setMessage={setMessage}
                />
            )}

            </div>
        </div>
    );
}
