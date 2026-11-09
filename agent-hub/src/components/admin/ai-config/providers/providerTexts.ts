// The words of the provider detail that differ per provider. One t() call per
// string with a literal key, so the i18n tooling can see them.

import type { TranslateFn } from '@/hooks/useTranslation';

export interface ProviderTexts {
    description: string;
    placeholder: string;
    docsLabel: string;
}

/** Description, key placeholder and docs label of an API-key provider. */
export function providerTexts(t: TranslateFn, id: string): ProviderTexts {
    switch (id) {
        case 'claude':
            return {
                description: t('admin_ai_config.pk_claude_desc', 'Required for Claude models (Opus, Sonnet, Haiku)'),
                placeholder: t('admin_ai_config.pk_claude_placeholder', 'Enter your Claude API key'),
                docsLabel: t('admin_ai_config.pk_claude_docs', 'console.anthropic.com'),
            };
        case 'openai':
            return {
                description: t('admin_ai_config.pk_openai_desc', 'Required for OpenAI models (GPT-6 Astra, GPT-5.6, o-series)'),
                placeholder: t('admin_ai_config.pk_openai_placeholder', 'Enter your OpenAI API key'),
                docsLabel: t('admin_ai_config.pk_openai_docs', 'platform.openai.com'),
            };
        case 'google':
            return {
                description: t('admin_ai_config.pk_google_desc', 'Required for Gemini models + Image Generation'),
                placeholder: t('admin_ai_config.pk_google_placeholder', 'Enter your Google AI API key'),
                docsLabel: t('admin_ai_config.pk_google_docs', 'aistudio.google.com'),
            };
        case 'mistral':
            return {
                description: t('admin_ai_config.pk_mistral_desc', 'Required for Mistral AI models'),
                placeholder: t('admin_ai_config.pk_mistral_placeholder', 'Enter your Mistral API key'),
                docsLabel: t('admin_ai_config.pk_mistral_docs', 'console.mistral.ai'),
            };
        case 'scaleway':
            return {
                description: t('admin_ai_config.pk_scaleway_desc', 'Open-weight models on EU serverless endpoints (Generative APIs)'),
                placeholder: t('admin_ai_config.pk_scaleway_placeholder', 'Enter your Scaleway secret key'),
                docsLabel: t('admin_ai_config.pk_scaleway_docs', 'console.scaleway.com'),
            };
        case 'eugpt':
            return {
                description: t('admin_ai_config.pk_eugpt_desc', 'EU-hosted models, routed per request by EU GPT. No tool calling, so agents and builders that use tools need another model'),
                placeholder: t('admin_ai_config.pk_eugpt_placeholder', 'Enter your EU GPT API key (eugpt_…)'),
                docsLabel: t('admin_ai_config.pk_eugpt_docs', 'chat.eugpt.ai → Settings → API Keys'),
            };
        case 'ionos':
            return {
                description: t('admin_ai_config.pk_ionos_desc', 'EU-hosted (Germany) open-weight models: chat, embeddings and reranking (AI Model Hub)'),
                placeholder: t('admin_ai_config.pk_ionos_placeholder', 'Enter your IONOS AI Model Hub API token'),
                docsLabel: t('admin_ai_config.pk_ionos_docs', 'docs.ionos.com'),
            };
        case 'elevenlabs':
            return {
                description: t('admin_ai_config.pk_elevenlabs_desc', 'Required for Music (with vocals), TTS & Sound Effects'),
                placeholder: t('admin_ai_config.pk_elevenlabs_placeholder', 'Enter your ElevenLabs API key'),
                docsLabel: t('admin_ai_config.pk_elevenlabs_docs', 'elevenlabs.io'),
            };
        default:
            return { description: '', placeholder: '', docsLabel: '' };
    }
}

/** The one-line description of a provider that has a form instead of one key. */
export function customProviderDescription(t: TranslateFn, id: string): string {
    if (id === 'azure') return t('admin_ai_config.azure_subtitle', 'Azure OpenAI Service');
    if (id === 'vertex') return t('admin_ai_config.vertex_subtitle', 'EU-hosted Gemini via Vertex AI');
    return '';
}
