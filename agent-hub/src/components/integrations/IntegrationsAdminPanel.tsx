import React from 'react';
import { useLicenseContext } from '../licensing/LicenseContext';
import EmailSection from './IntegrationsAdminPanel/EmailSection';
import GlobalDefaultsSection from './IntegrationsAdminPanel/GlobalDefaultsSection';
import SearchSection from './IntegrationsAdminPanel/SearchSection';
import { SECTIONS, MOUNT_ONLY_SECTIONS, SECTION_FEATURE_GATE, ENTERPRISE_ONLY_SECTIONS } from './IntegrationsAdminPanel/sections';
import ServicesSection from './IntegrationsAdminPanel/ServicesSection';
import TranscriptionSection from './IntegrationsAdminPanel/TranscriptionSection';
import useIntegrationDefaults from './IntegrationsAdminPanel/useIntegrationDefaults';
import useIntegrationsAdminState from './IntegrationsAdminPanel/useIntegrationsAdminState';
import useServiceEmailActions from './IntegrationsAdminPanel/useServiceEmailActions';
import useTranscriptionSettings from './IntegrationsAdminPanel/useTranscriptionSettings';
import { useTranslation } from '../../hooks/useTranslation';
import SectionNav from '../shared/SectionNav';
import StudioShell from '../shared/StudioShell';
import Spinner from '@/components/shared/Spinner';
import { useToastOnMessage } from '@/components/admin/ai-config/ui/useToastOnMessage';
import { useShellProps } from '@/authedApp/useShellProps';

interface IntegrationsAdminPanelProps {
    activeSection?: string;
    onNavigate?: (page: string) => void;
    /**
     * The sections this mount offers, without a section column (the admin
     * dashboard's Platform services child rows, the search provider inside AI
     * configuration > Search & retrieval, which only a mount that names it
     * gets). Left out: every Platform services section, with the column.
     */
    sections?: readonly string[];
}

/**
 * Platform services (the old Integrations tab): the defaults for new
 * organisations, the service e-mail, transcription and the connected apps. The
 * feature switches are under Licence & features now (an old address there is
 * aliased), the web search provider under AI configuration. In the admin
 * dashboard each section is a child row and the page frame draws its header.
 */
export default function IntegrationsAdminPanel({ activeSection: activeProp = 'defaults', onNavigate: onNavigateProp, sections: offered }: IntegrationsAdminPanelProps) {
    const { t } = useTranslation();
    // Inside the app shell the navigation comes from context; a host outside
    // it (a test, a kit) still hands it as a prop.
    const { onNavigate } = useShellProps({ onNavigate: onNavigateProp });
    const { hasFeature, hasTier } = useLicenseContext();
    const isEnterprise = hasTier('enterprise');
    // Hide enterprise-gated sections on Community. A deep link to a hidden
    // section (or a tier downgrade) falls back to the always-visible defaults
    // section so the enterprise panel never renders.
    const candidates = offered ? [...SECTIONS, ...MOUNT_ONLY_SECTIONS].filter(s => offered.includes(s.id)) : SECTIONS;
    const visibleSections = candidates.filter(
        s => (!SECTION_FEATURE_GATE[s.id] || hasFeature(SECTION_FEATURE_GATE[s.id]))
            && (!ENTERPRISE_ONLY_SECTIONS.has(s.id) || isEnterprise)
    );
    const visibleIds = visibleSections.map(s => s.id);
    const active = visibleIds.includes(activeProp) ? activeProp : (visibleIds[0] ?? '');
    // The MCP marketplace moved to the whole-server MCP servers row (the
    // organisation's own servers are Organisation > MCP servers). An old link or
    // bookmark to admin/integrations/mcp lands there instead of on Features.
    React.useEffect(() => {
        if (activeProp === 'mcp' && onNavigate) onNavigate('admin/mcp-servers');
    }, [activeProp, onNavigate]);
    const handleSectionClick = (id: string) => {
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
    // A section reports a save as a message; it is said once, as a toast.
    useToastOnMessage(message);

    if (loading) {
        return (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-[var(--text-tertiary)]">
                <Spinner size="sm" /> {t('integ.integrations_admin_loading_integrations', 'Loading integrations...')}
            </div>
        );
    }

    const body = (
            <>
            {active === 'defaults' && (
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

            {active === 'connected-apps' && (
                <ServicesSection
                    enterprise={isEnterprise}
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
            </>
    );
    if (offered) return body;

    return (
        <StudioShell
            responsive
            sidebarTitle={t('admin_platform.title', 'Platform services')}
            sidebar={(
                <SectionNav
                    label={t('admin_platform.title', 'Platform services')}
                    items={visibleSections.map(sec => ({ id: sec.id, icon: sec.icon, label: t(sec.labelKey, sec.fallback) }))}
                    activeId={active}
                    onSelect={handleSectionClick}
                />
            )}
        >
            <div className="p-6 md:p-8">{body}</div>
        </StudioShell>
    );
}
