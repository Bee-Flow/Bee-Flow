// Per-provider metadata for the simple "one API key" providers (Claude, OpenAI,
// Google AI, Mistral, Scaleway, EU GPT, ElevenLabs). Each entry drives the
// API-key section of the provider detail (providers/ApiKeyDetail.tsx); the
// texts (description, placeholder, docs label) live in providers/providerTexts.ts
// so they go through t(). Fields:
//
//   name        - display name; the detail derives the "<name> API key saved!"
//                 and "<name> API key removed" toasts from it
//   statusField - boolean has-key flag in the GET /ai/config response
//   bodyField   - POST /ai/config body field that stores the key
//   deleteSlug  - DELETE /ai/config/key/<slug> identifier
//   icon        - avatar emoji (on the neutral chip of providerRegistry.ts)
//   docsUrl     - "Get your API key from ..." link

export type ProviderKeyConfig = {
    name: string;
    statusField: string;
    bodyField: string;
    deleteSlug: string;
    icon: string;
    docsUrl: string;
};

export const PROVIDER_KEY_CONFIGS: Record<string, ProviderKeyConfig> = {
    claude: {
        name: 'Claude',
        statusField: 'hasClaudeKey',
        bodyField: 'claudeApiKey',
        deleteSlug: 'claude_api_key',
        icon: '🧠',
        docsUrl: 'https://console.anthropic.com/settings/keys',
    },
    openai: {
        name: 'OpenAI',
        statusField: 'hasOpenaiKey',
        bodyField: 'openaiApiKey',
        deleteSlug: 'openai_api_key',
        icon: '🤖',
        docsUrl: 'https://platform.openai.com/api-keys',
    },
    google: {
        name: 'Google AI',
        statusField: 'hasGoogleKey',
        bodyField: 'googleApiKey',
        deleteSlug: 'google_api_key',
        icon: '✨',
        docsUrl: 'https://aistudio.google.com/apikey',
    },
    mistral: {
        name: 'Mistral',
        statusField: 'hasMistralKey',
        bodyField: 'mistralApiKey',
        deleteSlug: 'mistral_api_key',
        icon: '🌪️',
        docsUrl: 'https://console.mistral.ai',
    },
    scaleway: {
        name: 'Scaleway',
        statusField: 'hasScalewayKey',
        bodyField: 'scalewayApiKey',
        deleteSlug: 'scaleway_api_key',
        icon: '🇪🇺',
        docsUrl: 'https://console.scaleway.com/iam/api-keys',
    },
    eugpt: {
        name: 'EU GPT',
        statusField: 'hasEuGptKey',
        bodyField: 'eugptApiKey',
        deleteSlug: 'eugpt_api_key',
        icon: '🇪🇺',
        docsUrl: 'https://chat.eugpt.ai',
    },
    ionos: {
        name: 'IONOS',
        statusField: 'hasIonosKey',
        bodyField: 'ionosApiKey',
        deleteSlug: 'ionos_api_key',
        icon: '🇪🇺',
        docsUrl: 'https://docs.ionos.com/cloud/ai/ai-model-hub',
    },
    elevenlabs: {
        name: 'ElevenLabs',
        statusField: 'hasElevenLabsKey',
        bodyField: 'elevenlabsApiKey',
        deleteSlug: 'elevenlabs_api_key',
        icon: '🎵',
        docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },
};
