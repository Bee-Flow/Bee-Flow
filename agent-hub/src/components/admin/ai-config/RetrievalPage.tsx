// The Search & retrieval page of AI configuration: the retrieval pipeline top
// to bottom, in one place. Knowledge bases: where search runs, the embedding
// model (and the Azure OpenAI one the Azure document pipeline uses), the rerank
// chain in the order it is tried. Web: the search provider with its keys and
// agent-search defaults, then the models the web search runs on. The page
// header comes from the dashboard frame (AdminPage).
import AzureEmbeddingsCard from './AzureEmbeddingsCard';
import EmbeddingsConfig from './EmbeddingsConfig';
import { CpuRerankerRow, KbProviderGroup } from './KnowledgeSearchSettings';
import RerankerConfig from './RerankerConfig';
import RerankerProviderSection from './RerankerProviderSection';
import WebSearchInferenceConfig from './WebSearchInferenceConfig';
import useWebSearchProvider from './useWebSearchProvider';
import type { ModelRow, ProviderRow } from './providers/useAiProviderModels';
import SearchSection from '@/components/integrations/IntegrationsAdminPanel/SearchSection';
import { SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { ProviderMessage } from '@/hooks/useProviderConfig';
import { useTranslation } from '@/hooks/useTranslation';

interface RetrievalPageProps {
    providers: ProviderRow[];
    allModels: ModelRow[];
    refreshModels: () => void;
    onMessage: (message: ProviderMessage) => void;
}

/** The knowledge-base rerank chain, each tier a row in the order the server tries them. */
function RerankingGroup({ providers, allModels, onMessage }: Omit<RetrievalPageProps, 'refreshModels'>) {
    const { t } = useTranslation();
    return (
        <SettingsGroup
            title={t('ai_model_setup.rerank_group_title', 'Reranking')}
            description={t('ai_model_setup.rerank_group_hint', 'Knowledge-base results are re-scored by the first reranker below that is set up and answers.')}
        >
            <SettingsList>
                <RerankerProviderSection providers={providers} allModels={allModels} onMessage={onMessage} />
                <RerankerConfig onMessage={onMessage} />
                <CpuRerankerRow />
            </SettingsList>
        </SettingsGroup>
    );
}

/** The web search provider form, on its own state (not the integrations panel's). */
function WebSearchProviderConfig() {
    const { loading, ...props } = useWebSearchProvider();
    if (loading) return null;
    return <SearchSection {...props} />;
}

export default function RetrievalPage({ providers, allModels, refreshModels, onMessage }: RetrievalPageProps) {
    return (
        <div className="flex flex-col gap-10">
            <KbProviderGroup />
            <EmbeddingsConfig providers={providers} allModels={allModels} fetchAllModels={refreshModels} />
            <AzureEmbeddingsCard />
            <RerankingGroup providers={providers} allModels={allModels} onMessage={onMessage} />
            <WebSearchProviderConfig />
            <WebSearchInferenceConfig allModels={allModels} />
        </div>
    );
}
