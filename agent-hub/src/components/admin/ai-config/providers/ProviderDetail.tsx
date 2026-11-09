// The detail pane of one cloud provider: header, the key (or the provider's own
// form), the provider-specific options and the models it offers.

import ApiKeyDetail from './ApiKeyDetail';
import AzureForm from './AzureForm';
import OpenAIRegionToggle from './OpenAIRegionToggle';
import PaneHeader from './PaneHeader';
import ProviderModels from './ProviderModels';
import { customProviderDescription, providerTexts } from './providerTexts';
import type { ProviderEntry } from './providerRegistry';
import type { AiConfigBag, ProviderPaneProps } from './types';
import type { ModelRow } from './useAiProviderModels';
import VertexForm from './VertexForm';
import { useTranslation } from '@/hooks/useTranslation';

interface ProviderDetailProps extends ProviderPaneProps {
    entry: ProviderEntry;
    config: AiConfigBag;
    /** Every model of every provider; the detail keeps the ones of this provider. */
    allModels: ModelRow[];
    loadingModels?: boolean;
}

function ProviderBody({ entry, onMessage }: { entry: ProviderEntry } & ProviderPaneProps) {
    const { t } = useTranslation();
    if (entry.kind === 'custom') {
        return entry.id === 'azure' ? <AzureForm onMessage={onMessage} /> : <VertexForm onMessage={onMessage} />;
    }
    if (!entry.keyConfig) return null;
    return (
        <ApiKeyDetail provider={entry.keyConfig} texts={providerTexts(t, entry.id)} onMessage={onMessage}>
            {entry.id === 'openai' && <OpenAIRegionToggle onMessage={onMessage} />}
            {entry.id === 'scaleway' && (
                // One Scaleway secret key opens every Scaleway API, so this is the same key the
                // Whisper transcription integration uses (Admin -> Integrations -> Transcription).
                // Say so out loud, so an admin does not go looking for a second key.
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                    {t('admin_ai_config.scaleway_hint', 'Serverless open-weight models (Qwen, Mistral, Gemma, GLM, DeepSeek, gpt-oss) served from EU data centres and billed per token. The same secret key is used for Scaleway Whisper transcription under Integrations.')}
                </p>
            )}
            {entry.id === 'ionos' && (
                <p className="mt-3 text-xs text-[var(--text-muted)]">
                    {t('admin_ai_config.ionos_hint', 'Open-weight models hosted by IONOS in Germany (AI Model Hub): chat, embeddings and reranking, billed per token. Reranking is set up separately under Reranker.')}
                </p>
            )}
        </ApiKeyDetail>
    );
}

export default function ProviderDetail({ entry, config, allModels, loadingModels, onMessage }: ProviderDetailProps) {
    const { t } = useTranslation();
    const texts = providerTexts(t, entry.id);
    const models = allModels.filter(m => m.providerName === entry.name);
    return (
        <div className="flex flex-col gap-4">
            <PaneHeader
                icon={entry.icon}
                iconClass={entry.iconClass}
                title={entry.name}
                connected={entry.isConnected(config)}
                description={entry.kind === 'apiKey' ? texts.description : customProviderDescription(t, entry.id)}
                docsUrl={entry.keyConfig?.docsUrl}
                docsLabel={entry.keyConfig ? texts.docsLabel : undefined}
            />
            <ProviderBody entry={entry} onMessage={onMessage} />
            <ProviderModels models={models} loading={loadingModels} />
        </div>
    );
}
