import { useCallback } from 'react';
import ChatModelTiersConfig from './ChatModelTiersConfig';
import DirectChatConfig from './DirectChatConfig';
import LimitsConfig from './LimitsConfig';
import RetrievalPage from './RetrievalPage';
import { AI_CONFIG_SECTIONS, MODEL_SECTIONS, aiConfigPath, sectionIdOf } from './aiConfigSections';
import type { AiConfigSectionId } from './aiConfigSections';
import { RERANKER_ID } from './providers/providerRegistry';
import ProvidersSection from './providers/ProvidersSection';
import { useAiProviderModels } from './providers/useAiProviderModels';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import StudioShell from '@/components/shared/StudioShell';
import toast from '@/components/shared/Toast';
import { useTranslation } from '@/hooks/useTranslation';
import type { ProviderMessage } from '@/hooks/useProviderConfig';
import { useShellProps } from '@/authedApp/useShellProps';

interface AIConfigPanelProps {
    /** The section from the URL (admin/ai-config/<section>); the first one when missing or unknown. */
    activeSection?: string;
    /** The provider pane from the URL (admin/ai-config/providers/<id>). */
    activeProvider?: string;
    onNavigate?: (path: string) => void;
    /**
     * false: the admin dashboard, whose child rows are the sections and whose
     * page frame (AdminPage) draws the header, padding and width: the panel
     * renders the section body only. true: its own section column and header.
     */
    nav?: boolean;
}

/** What a pane reports through `onMessage`, as a toast. */
const notify = ({ type, text }: ProviderMessage) => (type === 'success' ? toast.success(text) : toast.error(text));

/**
 * The section to show. The reranker had a pane in the provider list
 * (providers/reranker); it is part of Search & retrieval now.
 */
function resolveSection(activeSection: string | undefined, provider: string | undefined): AiConfigSectionId {
    const section = sectionIdOf(activeSection) ?? 'providers';
    return section === 'providers' && provider === RERANKER_ID ? 'retrieval' : section;
}

const AIConfigPanel = ({ activeSection, activeProvider, onNavigate: onNavigateProp, nav = true }: AIConfigPanelProps) => {
    const { t } = useTranslation();
    // Inside the app shell the navigation comes from context; a host outside
    // it (a test, a kit) still hands it as a prop.
    const { onNavigate } = useShellProps({ onNavigate: onNavigateProp });
    const decodedProvider = (() => {
        try { return activeProvider ? decodeURIComponent(activeProvider) : undefined; } catch { return activeProvider; }
    })();
    const section = resolveSection(activeSection, decodedProvider);
    const models = useAiProviderModels(MODEL_SECTIONS.has(section));

    const go = useCallback((path: string) => onNavigate?.(path), [onNavigate]);
    // Inner "go to ..." buttons name a section (or an old tab name); map it onto its URL.
    const goToSection = useCallback((name: string) => {
        const id = sectionIdOf(name);
        if (id) go(aiConfigPath(id));
    }, [go]);

    if (models.providersLoading) return <div className="p-4 text-sm text-[var(--text-tertiary)]">{t('admin_ai_config.index_loading_providers', 'Loading providers...')}</div>;

    // The names the dashboard's rail rows give the sections (adminTabRows AI_CONFIG_RAIL_ROWS).
    const labels: Record<AiConfigSectionId, string> = {
        providers: t('admin_nav.ai_providers', 'Providers'),
        models: t('admin_nav.models', 'Models'),
        retrieval: t('admin_nav.ai_retrieval', 'Search & retrieval'),
        'direct-chat': t('admin_nav.ai_direct_chat', 'Direct chat'),
        limits: t('admin_nav.ai_limits', 'Limits'),
    };

    const body = (
        <>
            {section === 'providers' && (
                <ProvidersSection
                    selectedId={decodedProvider}
                    onSelect={(id) => go(aiConfigPath('providers', id))}
                    allModels={models.allModels}
                    loadingModels={models.loadingModels}
                    onProvidersChanged={models.refresh}
                    onMessage={notify}
                />
            )}
            {section === 'models' && <ChatModelTiersConfig allModels={models.allModels} />}
            {section === 'retrieval' && (
                <RetrievalPage providers={models.providers} allModels={models.allModels} refreshModels={models.refresh} onMessage={notify} />
            )}
            {section === 'direct-chat' && <DirectChatConfig />}
            {section === 'limits' && <LimitsConfig onNavigateToTab={goToSection} />}
        </>
    );
    if (!nav) return body;

    const sidebar = (
        <SectionNav
            label={t('admin_nav.ai_config', 'AI configuration')}
            items={AI_CONFIG_SECTIONS.map(({ id, icon }) => ({ id, icon, label: labels[id] }))}
            activeId={section}
            onSelect={(id) => go(aiConfigPath(id as AiConfigSectionId))}
        />
    );
    return (
        <StudioShell responsive sidebarTitle={t('admin_nav.ai_config', 'AI configuration')} sidebar={sidebar}>
            <div className="flex flex-col gap-6 p-6 md:p-8">
                <SectionHeader title={labels[section]} />
                {body}
            </div>
        </StudioShell>
    );
};

export default AIConfigPanel;
