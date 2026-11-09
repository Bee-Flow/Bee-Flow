import { useCallback } from 'react';
import ChatModelTiersConfig from './ChatModelTiersConfig';
import DirectChatConfig from './DirectChatConfig';
import EmbeddingsConfig from './EmbeddingsConfig';
import LimitsConfig from './LimitsConfig';
import WebSearchInferenceConfig from './WebSearchInferenceConfig';
import { AI_CONFIG_SECTIONS, MODEL_SECTIONS, aiConfigPath, sectionIdOf } from './aiConfigSections';
import type { AiConfigSectionId } from './aiConfigSections';
import ProvidersSection from './providers/ProvidersSection';
import { useAiProviderModels } from './providers/useAiProviderModels';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import toast from '@/components/shared/Toast';
import { useTranslation } from '@/hooks/useTranslation';
import type { ProviderMessage } from '@/hooks/useProviderConfig';

interface AIConfigPanelProps {
    /** The section from the URL (admin/ai-config/<section>); the first one when missing or unknown. */
    activeSection?: string;
    /** The provider pane from the URL (admin/ai-config/providers/<id>). */
    activeProvider?: string;
    onNavigate?: (path: string) => void;
}

/** What a pane reports through `onMessage`, as a toast. */
const notify = ({ type, text }: ProviderMessage) => (type === 'success' ? toast.success(text) : toast.error(text));

const AIConfigPanel = ({ activeSection, activeProvider, onNavigate }: AIConfigPanelProps) => {
    const { t } = useTranslation();
    const section: AiConfigSectionId = sectionIdOf(activeSection) ?? 'providers';
    const models = useAiProviderModels(MODEL_SECTIONS.has(section));

    const go = useCallback((path: string) => onNavigate?.(path), [onNavigate]);
    // Inner "go to ..." buttons still name a tab; map it onto its section.
    const goToTab = useCallback((tab: string) => {
        const id = sectionIdOf(tab);
        if (id) go(aiConfigPath(id));
    }, [go]);
    const decodedProvider = (() => {
        try { return activeProvider ? decodeURIComponent(activeProvider) : undefined; } catch { return activeProvider; }
    })();

    if (models.providersLoading) return <div className="p-4 text-sm text-[var(--text-muted)]">{t('admin_ai_config.index_loading_providers', 'Loading providers...')}</div>;

    const labels: Record<AiConfigSectionId, string> = {
        providers: t('admin.ai_api_keys'),
        'chat-models': t('admin.ai_chat_models'),
        embeddings: t('admin.ai_embeddings', 'Embeddings'),
        'direct-chat': t('admin.ai_direct_chat'),
        'web-search': t('admin.ai_web_search_inference', 'Web Search Inference'),
        limits: t('admin.ai_limits', 'Limits & Self-host'),
    };

    const sidebar = (
        <SectionNav
            label={t('admin_ai_config.index_title', 'AI Configuration')}
            items={AI_CONFIG_SECTIONS.map(({ id, icon }) => ({ id, icon, label: labels[id] }))}
            activeId={section}
            onSelect={(id) => go(aiConfigPath(id as AiConfigSectionId))}
        />
    );

    return (
        <StudioShell responsive sidebarTitle={t('admin_ai_config.index_title', 'AI Configuration')} sidebar={sidebar}>
            <div className="p-6 md:p-8">
                {section === 'providers' && (
                    <ProvidersSection
                        selectedId={decodedProvider}
                        onSelect={(id) => go(aiConfigPath('providers', id))}
                        providers={models.providers}
                        allModels={models.allModels}
                        loadingModels={models.loadingModels}
                        onProvidersChanged={models.refresh}
                        onMessage={notify}
                    />
                )}
                {section === 'chat-models' && <ChatModelTiersConfig allModels={models.allModels} />}
                {section === 'embeddings' && (
                    <EmbeddingsConfig providers={models.providers} allModels={models.allModels} fetchAllModels={models.refresh} />
                )}
                {section === 'direct-chat' && <DirectChatConfig />}
                {section === 'web-search' && <WebSearchInferenceConfig allModels={models.allModels} onNavigateToTab={goToTab} />}
                {section === 'limits' && <LimitsConfig onNavigateToTab={goToTab} />}
            </div>
        </StudioShell>
    );
};

export default AIConfigPanel;
