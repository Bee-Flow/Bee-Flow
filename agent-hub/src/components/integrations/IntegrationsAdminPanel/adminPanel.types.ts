import type { Dispatch, SetStateAction } from 'react';

export interface AdminMessage {
    type: 'success' | 'error';
    text: string;
}

/** The panel's status toast: a message for a few seconds, then null. */
export type SetMessage = (message: AdminMessage | null) => void;

type SetString = (value: string) => void;
type SetBool = (value: boolean) => void;

/** One toggleable integration, built-in or an installed MCP server. */
export interface DefaultIntegration {
    id: string;
    label: string;
    description?: string;
    category: string;
    icon?: string;
}

export interface GlobalDefaultsSectionProps {
    enableAllDefaults: () => void;
    disableAllDefaults: () => void;
    categories: string[];
    allIntegrations: DefaultIntegration[];
    isDefaultEnabled: (id: string) => boolean;
    toggleDefault: (id: string) => void;
}

export interface EmailSectionProps {
    hasServiceEmail: boolean;
    serviceEmailAddress: string;
    disconnectServiceEmail: () => void;
    savingServiceEmail: boolean;
    serviceEmailDisplayName: string;
    setServiceEmailDisplayName: SetString;
    saveServiceEmailDisplayName: () => void;
    showTestEmail: boolean;
    setShowTestEmail: SetBool;
    startServiceEmailConnect: () => void;
    connectingServiceEmail: boolean;
    testEmailRecipient: string;
    setTestEmailRecipient: SetString;
    testingServiceEmail: boolean;
    setTestingServiceEmail: SetBool;
    setMessage: SetMessage;
}

interface SearchModeSettings {
    max_results: number;
    max_tokens_markdown: number;
    detail_level?: string;
}

export interface AgentSearchDefaults {
    mode: string;
    include_citations: boolean;
    web: Partial<SearchModeSettings & { fetch_top_n: number }>;
    web_fast: Partial<SearchModeSettings>;
}

export interface SearchSectionProps {
    searchProvider: string;
    setSearchProvider: SetString;
    bingSearchKey: string;
    setBingSearchKey: SetString;
    hasBingSearchKey: boolean;
    setHasBingSearchKey: SetBool;
    bingSearchMarket: string;
    setBingSearchMarket: SetString;
    savingBingKey: boolean;
    setSavingBingKey: SetBool;
    agentSearchUrl: string;
    hasAgentSearchUrl: boolean;
    serperApiKey: string;
    setSerperApiKey: SetString;
    hasSerperKey: boolean;
    setHasSerperKey: SetBool;
    savingSerperKey: boolean;
    setSavingSerperKey: SetBool;
    agentSearchDefaults: AgentSearchDefaults;
    setAgentSearchDefaults: Dispatch<SetStateAction<AgentSearchDefaults>>;
    savingSearchDefaults: boolean;
    setSavingSearchDefaults: SetBool;
    setMessage: SetMessage;
}

export interface ServicesSectionProps {
    linkedinClientId: string;
    setLinkedinClientId: SetString;
    linkedinClientSecret: string;
    setLinkedinClientSecret: SetString;
    hasLinkedInConfig: boolean;
    setHasLinkedInConfig: SetBool;
    savingLinkedIn: boolean;
    setSavingLinkedIn: SetBool;
    withingsClientId: string;
    setWithingsClientId: SetString;
    withingsClientSecret: string;
    setWithingsClientSecret: SetString;
    hasWithingsConfig: boolean;
    setHasWithingsConfig: SetBool;
    savingWithings: boolean;
    setSavingWithings: SetBool;
    azureDocEndpoint: string;
    setAzureDocEndpoint: SetString;
    azureDocKey: string;
    setAzureDocKey: SetString;
    hasAzureDocEndpoint: boolean;
    setHasAzureDocEndpoint: SetBool;
    hasAzureDocKey: boolean;
    setHasAzureDocKey: SetBool;
    savingAzureDoc: boolean;
    setSavingAzureDoc: SetBool;
    azureEmbedEndpoint: string;
    setAzureEmbedEndpoint: SetString;
    azureEmbedKey: string;
    setAzureEmbedKey: SetString;
    azureEmbedModel: string;
    setAzureEmbedModel: SetString;
    hasAzureEmbedEndpoint: boolean;
    setHasAzureEmbedEndpoint: SetBool;
    hasAzureEmbedKey: boolean;
    setHasAzureEmbedKey: SetBool;
    savingAzureEmbed: boolean;
    setSavingAzureEmbed: SetBool;
    useAzureDocProcessing: boolean;
    setUseAzureDocProcessing: SetBool;
    savingAzureToggle: boolean;
    setSavingAzureToggle: SetBool;
    setMessage: SetMessage;
}

export interface TranscriptionSectionProps {
    transcriptionProvider: string;
    setTranscriptionProvider: SetString;
    savingTranscriptionProvider: boolean;
    setSavingTranscriptionProvider: SetBool;
    hasAzureSpeechKey: boolean;
    setHasAzureSpeechKey: SetBool;
    azureSpeechKey: string;
    setAzureSpeechKey: SetString;
    azureSpeechRegion: string;
    setAzureSpeechRegion: SetString;
    savingAzureSpeech: boolean;
    setSavingAzureSpeech: SetBool;
    whisperxUrl: string;
    setWhisperxUrl: SetString;
    whisperxToken: string;
    setWhisperxToken: SetString;
    hasWhisperxUrl: boolean;
    setHasWhisperxUrl: SetBool;
    hasWhisperxToken: boolean;
    setHasWhisperxToken: SetBool;
    savingWhisperx: boolean;
    setSavingWhisperx: SetBool;
    scalewayApiKey: string;
    setScalewayApiKey: SetString;
    hasScalewayKey: boolean;
    setHasScalewayKey: SetBool;
    savingScaleway: boolean;
    setSavingScaleway: SetBool;
    pyannoteApiKey: string;
    setPyannoteApiKey: SetString;
    hasPyannoteKey: boolean;
    setHasPyannoteKey: SetBool;
    savingPyannote: boolean;
    setSavingPyannote: SetBool;
    pyannoteTranscriptionModel: string;
    saveTranscriptionModel: (model: string) => void;
    savingPyannoteModel: boolean;
    voiceprintMatchingEnabled: boolean;
    saveVoiceprintSettings: (patch: { voiceprintMatchingEnabled?: boolean; pyannoteIdentifyThreshold?: number }) => void;
    savingVoiceprint: boolean;
    pyannoteIdentifyThreshold: number;
    setPyannoteIdentifyThreshold: (value: number) => void;
    setMessage: SetMessage;
}
