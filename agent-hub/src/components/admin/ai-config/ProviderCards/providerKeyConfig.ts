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
//   icon / iconClass - avatar emoji + Tailwind background class (literal, so
//                 the scanner keeps it)
//   docsUrl     - "Get your API key from ..." link

export type ProviderKeyConfig = {
    name: string;
    statusField: string;
    bodyField: string;
    deleteSlug: string;
    icon: string;
    iconClass: string;
    docsUrl: string;
};

export const PROVIDER_KEY_CONFIGS: Record<string, ProviderKeyConfig> = {
    claude: {
        name: 'Claude',
        statusField: 'hasClaudeKey',
        bodyField: 'claudeApiKey',
        deleteSlug: 'claude_api_key',
        icon: '🧠',
        iconClass: 'bg-[rgba(217,119,6,0.15)]',
        docsUrl: 'https://console.anthropic.com/settings/keys',
    },
    openai: {
        name: 'OpenAI',
        statusField: 'hasOpenaiKey',
        bodyField: 'openaiApiKey',
        deleteSlug: 'openai_api_key',
        icon: '🤖',
        iconClass: 'bg-[rgba(16,185,129,0.15)]',
        docsUrl: 'https://platform.openai.com/api-keys',
    },
    google: {
        name: 'Google AI',
        statusField: 'hasGoogleKey',
        bodyField: 'googleApiKey',
        deleteSlug: 'google_api_key',
        icon: '✨',
        iconClass: '[background:linear-gradient(135deg,rgba(66,133,244,0.2),rgba(234,67,53,0.2),rgba(251,188,4,0.2),rgba(52,168,83,0.2))]',
        docsUrl: 'https://aistudio.google.com/apikey',
    },
    mistral: {
        name: 'Mistral',
        statusField: 'hasMistralKey',
        bodyField: 'mistralApiKey',
        deleteSlug: 'mistral_api_key',
        icon: '🌪️',
        iconClass: 'bg-[rgba(139,92,246,0.15)]',
        docsUrl: 'https://console.mistral.ai',
    },
    scaleway: {
        name: 'Scaleway',
        statusField: 'hasScalewayKey',
        bodyField: 'scalewayApiKey',
        deleteSlug: 'scaleway_api_key',
        icon: '🇪🇺',
        iconClass: 'bg-[rgba(79,13,224,0.15)]',
        docsUrl: 'https://console.scaleway.com/iam/api-keys',
    },
    eugpt: {
        name: 'EU GPT',
        statusField: 'hasEuGptKey',
        bodyField: 'eugptApiKey',
        deleteSlug: 'eugpt_api_key',
        icon: '🇪🇺',
        iconClass: 'bg-[rgba(37,99,235,0.15)]',
        docsUrl: 'https://chat.eugpt.ai',
    },
    ionos: {
        name: 'IONOS',
        statusField: 'hasIonosKey',
        bodyField: 'ionosApiKey',
        deleteSlug: 'ionos_api_key',
        icon: '🇪🇺',
        iconClass: 'bg-[rgba(0,61,142,0.15)]',
        docsUrl: 'https://docs.ionos.com/cloud/ai/ai-model-hub',
    },
    elevenlabs: {
        name: 'ElevenLabs',
        statusField: 'hasElevenLabsKey',
        bodyField: 'elevenlabsApiKey',
        deleteSlug: 'elevenlabs_api_key',
        icon: '🎵',
        iconClass: '[background:linear-gradient(135deg,rgba(99,102,241,0.2),rgba(236,72,153,0.2))]',
        docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
    },
};
