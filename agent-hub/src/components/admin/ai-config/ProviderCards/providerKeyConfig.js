// Per-provider metadata for the simple "one API key" provider cards
// (Claude, OpenAI, Google AI, Mistral, Scaleway, EU GPT, ElevenLabs). Each entry drives one
// <ProviderApiKeyCard/>; the card files themselves are thin wrappers around
// it. Fields:
//
//   name        — display name; the card derives the "<name> API Key" title
//                 and the "<name> API key saved!/removed" toasts from it
//   statusField — boolean has-key flag in the GET /ai/config response
//   bodyField   — POST /ai/config body field that stores the key
//   deleteSlug  — DELETE /ai/config/key/<slug> identifier
//   icon / iconBackground — card avatar emoji + background style
//   description — helper text shown while no key is configured
//   placeholder — input placeholder while no key is configured
//   docsUrl / docsLabel — "Get your API key from …" footer link

export const PROVIDER_KEY_CONFIGS = {
    claude: {
        name: 'Claude',
        statusField: 'hasClaudeKey',
        bodyField: 'claudeApiKey',
        deleteSlug: 'claude_api_key',
        icon: '🧠',
        iconBackground: 'rgba(217, 119, 6, 0.15)',
        description: 'Required for Claude models (Opus, Sonnet, Haiku)',
        placeholder: 'Enter your Claude API key',
        docsUrl: 'https://console.anthropic.com/settings/keys',
        docsLabel: 'console.anthropic.com'
    },
    openai: {
        name: 'OpenAI',
        statusField: 'hasOpenaiKey',
        bodyField: 'openaiApiKey',
        deleteSlug: 'openai_api_key',
        icon: '🤖',
        iconBackground: 'rgba(16, 185, 129, 0.15)',
        description: 'Required for OpenAI models (GPT-6 Astra, GPT-5.6, o-series)',
        placeholder: 'Enter your OpenAI API key',
        docsUrl: 'https://platform.openai.com/api-keys',
        docsLabel: 'platform.openai.com'
    },
    google: {
        name: 'Google AI',
        statusField: 'hasGoogleKey',
        bodyField: 'googleApiKey',
        deleteSlug: 'google_api_key',
        icon: '✨',
        iconBackground: 'linear-gradient(135deg, rgba(66,133,244,0.2), rgba(234,67,53,0.2), rgba(251,188,4,0.2), rgba(52,168,83,0.2))',
        description: 'Required for Gemini models + Image Generation',
        placeholder: 'Enter your Google AI API key',
        docsUrl: 'https://aistudio.google.com/apikey',
        docsLabel: 'aistudio.google.com'
    },
    mistral: {
        name: 'Mistral',
        statusField: 'hasMistralKey',
        bodyField: 'mistralApiKey',
        deleteSlug: 'mistral_api_key',
        icon: '🌪️',
        iconBackground: 'rgba(139, 92, 246, 0.15)',
        description: 'Required for Mistral AI models',
        placeholder: 'Enter your Mistral API key',
        docsUrl: 'https://console.mistral.ai',
        docsLabel: 'console.mistral.ai'
    },
    scaleway: {
        name: 'Scaleway',
        statusField: 'hasScalewayKey',
        bodyField: 'scalewayApiKey',
        deleteSlug: 'scaleway_api_key',
        icon: '🇪🇺',
        iconBackground: 'rgba(79, 13, 224, 0.15)',
        description: 'Open-weight models on EU serverless endpoints (Generative APIs)',
        placeholder: 'Enter your Scaleway secret key',
        docsUrl: 'https://console.scaleway.com/iam/api-keys',
        docsLabel: 'console.scaleway.com'
    },
    eugpt: {
        name: 'EU GPT',
        statusField: 'hasEuGptKey',
        bodyField: 'eugptApiKey',
        deleteSlug: 'eugpt_api_key',
        icon: '🇪🇺',
        iconBackground: 'rgba(37, 99, 235, 0.15)',
        description: 'EU-hosted models, routed per request by EU GPT. No tool calling, so agents and builders that use tools need another model',
        placeholder: 'Enter your EU GPT API key (eugpt_…)',
        docsUrl: 'https://chat.eugpt.ai',
        docsLabel: 'chat.eugpt.ai → Settings → API Keys'
    },
    elevenlabs: {
        name: 'ElevenLabs',
        statusField: 'hasElevenLabsKey',
        bodyField: 'elevenlabsApiKey',
        deleteSlug: 'elevenlabs_api_key',
        icon: '🎵',
        iconBackground: 'linear-gradient(135deg, rgba(99,102,241,0.2), rgba(236,72,153,0.2))',
        description: 'Required for Music (with vocals), TTS & Sound Effects',
        placeholder: 'Enter your ElevenLabs API key',
        docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
        docsLabel: 'elevenlabs.io'
    }
};

export default PROVIDER_KEY_CONFIGS;
