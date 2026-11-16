// The Agent Designer's section navigation, its Knowledge section and the
// empty state.
import { INTEGRATION_CATALOG } from './integrations';
import { filterAvailableIntegrations, type IntegrationAvailabilityStatus } from './integrationAvailability';
import { USER_ACCESS, type DesignerIntegrationAccess } from './useDesignerIntegrationAccess';
import { Bot } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { PRIMARY_BTN } from '@/components/shared/adminUi';
import EmptyState from '@/components/shared/EmptyState';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import KnowledgePanelJs from '../../knowledge/KnowledgePanel';

const KnowledgePanel = KnowledgePanelJs;

/** The integration flags of GET /ai/user-settings the designer keeps (the whole payload). */
export type IntegrationStatus = IntegrationAvailabilityStatus & { [key: string]: unknown };

/** The designer's sections, in nav order; `tools` only when there is something to decide (always in admin mode). */
type DesignerSectionId = 'identity' | 'knowledge' | 'tools' | 'behavior' | 'share';

/** The section list on the left. */
export function DesignerSectionNav({ integrationStatus, access, activeSection, setActiveSection }: {
    integrationStatus: IntegrationStatus | null | undefined;
    /** How the Integrations section decides (useDesignerIntegrationAccess); the person's own access when absent. */
    access?: DesignerIntegrationAccess;
    activeSection: string | null;
    setActiveSection: (id: string) => void;
}) {
    const { t } = useTranslation();
    const how = access ?? USER_ACCESS;
    const hasIntegrations = how.adminMode || filterAvailableIntegrations(INTEGRATION_CATALOG, integrationStatus, how.how).length > 0;
    const items: { id: DesignerSectionId; label: string }[] = [
        { id: 'identity', label: t('agent_designer.nav_identity', 'Identity') },
        { id: 'knowledge', label: t('agent_designer.nav_knowledge', 'Knowledge') },
        ...(hasIntegrations ? [{ id: 'tools' as const, label: t('agent_designer.nav_integrations', 'Integrations') }] : []),
        { id: 'behavior', label: t('agent_designer.nav_behavior', 'Behavior') },
        { id: 'share', label: t('agent_designer.nav_share', 'Share & embed') },
    ];
    return (
        <div className="w-full shrink-0 border-b border-[var(--border-default)] md:w-40 md:border-b-0 md:border-r">
            <SectionNav
                label={t('agent_studio.agent_designer_sections', 'Agent settings')}
                items={items}
                activeId={activeSection ?? ''}
                onSelect={setActiveSection}
            />
        </div>
    );
}

export interface KnowledgeSectionProps {
    agentId: string | null;
    apiBase: string;
    strictKnowledge: boolean;
    setStrictKnowledge: (v: boolean) => void;
    includeSourceReferences: boolean;
    setIncludeSourceReferences: (v: boolean) => void;
    knowledgeBaseIds: string[];
    setKnowledgeBaseIds: (ids: string[]) => void;
}

/** Documents and facts the agent may use; a new agent has to be saved first. */
export function KnowledgeSection(p: KnowledgeSectionProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full flex-col gap-6">
            <SectionHeader
                title={t('agent_studio.agent_designer_knowledge_base', 'Knowledge Base')}
                description={t('agent_studio.agent_designer_upload_documents_or_add_facts_for_the', 'Upload documents or add facts for the agent to use.')}
            />

            <div className="flex-1 overflow-hidden">
                {p.agentId ? (
                    <KnowledgePanel
                        agentId={p.agentId}
                        API_BASE={p.apiBase}
                        strictKnowledge={p.strictKnowledge}
                        onStrictKnowledgeChange={p.setStrictKnowledge}
                        includeSourceReferences={p.includeSourceReferences}
                        onIncludeSourceReferencesChange={p.setIncludeSourceReferences}
                        knowledgeBaseIds={p.knowledgeBaseIds}
                        onKnowledgeBaseIdsChange={p.setKnowledgeBaseIds}
                    />
                ) : (
                    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-dashed border-[var(--border-default)] p-6 text-sm text-[var(--text-tertiary)]">
                        <p className="m-0">
                            {t('agent_studio.agent_designer_please_save_the_agent_first_to_add', 'Please save the agent first to add knowledge.')}
                        </p>
                    </div>
                )}
            </div>
        </div>
    );
}

/** Nothing selected: what the designer is for, and a way to start. */
export function DesignerEmptyState({ systemMode, onCreate }: { systemMode: boolean; onCreate: () => void }) {
    const { t } = useTranslation();
    return (
        <EmptyState
            className="flex-1"
            icon={<Bot className="h-10 w-10" />}
            title={t('agent_studio.agent_designer_agent_designer', 'Agent Designer')}
            description={systemMode
                ? t('agent_designer.empty_system', 'Select a system agent in the list to edit it.')
                : t('agent_studio.agent_designer_select_an_agent_from_the_sidebar_to', 'Select an agent from the sidebar to edit, or create a new one to start building your custom AI workflow assistant.')}
            action={systemMode ? undefined : (
                <button type="button" onClick={onCreate} className={PRIMARY_BTN}>
                    {t('agent_studio.agent_designer_create_new_agent', 'Create new agent')}
                </button>
            )}
        />
    );
}
