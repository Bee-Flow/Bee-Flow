// The Agent Designer's section navigation, its Knowledge section and the
// empty state. Split out of AgentDesigner/index.jsx without a change in
// behaviour.
import { INTEGRATION_CATALOG } from './integrations';
import { Bot } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { PRIMARY_BTN } from '@/components/mcpLibrary/ui';
import EmptyState from '@/components/shared/EmptyState';
import SectionHeader from '@/components/shared/SectionHeader';
import SectionNav from '@/components/shared/SectionNav';
import KnowledgePanelJs from '../../knowledge/KnowledgePanel';

const KnowledgePanel = KnowledgePanelJs;

/** The integration flags of GET /ai/user-settings this nav reads. */
export interface IntegrationStatus {
    orgEnabledIntegrations?: string[] | null;
    isGoogleUser?: boolean;
    hasFirefliesKey?: boolean;
    hasYouTrackConfig?: boolean;
    hasGammaKey?: boolean;
    hasAfasConfig?: boolean;
    hasN8nConfig?: boolean;
    hasLinkedInConfig?: boolean;
    linkedInConnected?: boolean;
    [key: string]: unknown;
}

interface CatalogItem { id: string; group?: string }

/**
 * Whether this person can use one catalog integration. Not the shared
 * filterAvailableIntegrations: this nav has always answered "no" before the
 * status loads, and knows AFAS but not Microsoft.
 */
function isIntegrationAvailable(item: CatalogItem, status: IntegrationStatus | null | undefined): boolean {
    if (!status) return false;
    const orgEnabled = status.orgEnabledIntegrations;
    if (orgEnabled && !orgEnabled.includes(item.id)) return false;
    if (item.group === 'google') return !!status.isGoogleUser;
    const byId: Record<string, () => boolean> = {
        fireflies: () => !!status.hasFirefliesKey,
        youtrack: () => !!status.hasYouTrackConfig,
        gamma: () => !!status.hasGammaKey,
        'afas-profit': () => !!status.hasAfasConfig,
        n8n: () => !!status.hasN8nConfig,
        linkedin: () => !!status.hasLinkedInConfig || !!status.linkedInConnected,
    };
    return byId[item.id] ? byId[item.id]() : true;
}

/** The section list on the left; Integrations only when one is available. */
export function DesignerSectionNav({ integrationStatus, activeSection, setActiveSection }: {
    integrationStatus: IntegrationStatus | null | undefined;
    activeSection: string | null;
    setActiveSection: (id: string) => void;
}) {
    const { t } = useTranslation();
    const hasIntegrations = (INTEGRATION_CATALOG as CatalogItem[]).some(item => isIntegrationAvailable(item, integrationStatus));
    const items = [
        { id: 'identity', label: 'Identity' },
        { id: 'knowledge', label: 'Knowledge' },
        ...(hasIntegrations ? [{ id: 'tools', label: 'Integrations' }] : []),
        { id: 'behavior', label: 'Behavior' },
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
            description={t('agent_studio.agent_designer_select_an_agent_from_the_sidebar_to', 'Select an agent from the sidebar to edit, or create a new one to start building your custom AI workflow assistant.')}
            action={systemMode ? undefined : (
                <button type="button" onClick={onCreate} className={PRIMARY_BTN}>
                    {t('agent_studio.agent_designer_create_new_agent', 'Create New Agent')}
                </button>
            )}
        />
    );
}
