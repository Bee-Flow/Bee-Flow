// The Agent Designer's section navigation, its Knowledge section and the
// empty state. Split out of AgentDesigner/index.jsx without a change in
// behaviour.
import { INTEGRATION_CATALOG } from './integrations';
import { useTranslation } from '@/hooks/useTranslation';
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
    const hasIntegrations = (INTEGRATION_CATALOG as CatalogItem[]).some(item => isIntegrationAvailable(item, integrationStatus));
    const items = [
        { id: 'identity', label: 'Identity' },
        { id: 'knowledge', label: 'Knowledge' },
        ...(hasIntegrations ? [{ id: 'tools', label: 'Integrations' }] : []),
        { id: 'behavior', label: 'Behavior' },
    ];
    return (
        <div className="w-40 flex flex-col py-3 border-r border-[var(--border-subtle)] bg-[var(--bg-primary)]">
            {items.map((item) => (
                <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    className={`text-left px-4 py-2 text-[13px] font-medium transition-all border-l-2 ${
                        activeSection === item.id
                            ? 'border-[var(--accent-primary)] text-[var(--text-primary)] bg-[var(--bg-tertiary)]/50'
                            : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]/30'
                    }`}
                >
                    {item.label}
                </button>
            ))}
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
        <div className="space-y-6 animate-fadeIn h-full flex flex-col">
            <div>
                <h2 className="text-base font-semibold text-primary">
                    {t('agent_studio.agent_designer_knowledge_base', 'Knowledge Base')}
                </h2>
                <p className="text-xs text-muted mt-0.5">
                    {t('agent_studio.agent_designer_upload_documents_or_add_facts_for_the', 'Upload documents or add facts for the agent to use.')}
                </p>
            </div>

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
                    <div className="h-full flex flex-col items-center justify-center text-muted border-2 border-dashed rounded-xl border-[var(--border-subtle)]">
                        <p>
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
        <div className="flex-1 flex flex-col items-center justify-center p-8 max-w-4xl mx-auto w-full [padding-bottom:20%]!">
            <h1
                className="text-center [font-size:32px]! [font-weight:600] [color:var(--text-primary)]! [margin-bottom:12px] [letter-spacing:-0.02em]"
            >
                {t('agent_studio.agent_designer_agent_designer', 'Agent Designer')}
            </h1>
            <p className="text-sm text-center mb-8 leading-relaxed [color:var(--text-muted)]! max-w-[420px]">
                {t('agent_studio.agent_designer_select_an_agent_from_the_sidebar_to', 'Select an agent from the sidebar to edit, or create a new one to start building your custom AI workflow assistant.')}
            </p>
            {!systemMode && (
                <button
                    onClick={onCreate}
                    className="px-6 py-2.5 rounded-full text-sm font-medium transition-all border hover:border-purple-500/30 hover:bg-[var(--bg-secondary)] [border-color:var(--border-subtle)]! [color:var(--text-primary)]! [background:var(--bg-card)]!"
                >
                    {t('agent_studio.agent_designer_create_new_agent', 'Create New Agent')}
                </button>
            )}
        </div>
    );
}
