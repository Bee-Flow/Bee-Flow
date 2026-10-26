// The Agent Designer's left column: the agents, with create / duplicate /
// delete. Split out of AgentDesigner/index.jsx without a change in behaviour.
import { useTranslation } from '@/hooks/useTranslation';
import { isImageAvatar, resolveAvatarSrc, pickAgentAvatar } from '@/utils/agentAvatar';

export interface DesignerAgent {
    id: string;
    name?: string;
    owner_id?: string;
    is_published?: boolean;
    avatar?: string | null;
    [key: string]: unknown;
}

export interface DesignerUser { id?: string; orgRole?: string | null; [key: string]: unknown }

export interface AgentListSidebarProps {
    agents: DesignerAgent[];
    selectedAgentId?: string;
    loading: boolean;
    systemMode: boolean;
    canManage: boolean;
    user: DesignerUser | null;
    onSelect: (agent: DesignerAgent) => void;
    onCreate: () => void;
    onDuplicate: (agent: DesignerAgent) => void;
    onDelete: (id: string) => void;
}

/** "Create with AI" goes to the wizard through the app's own history + popstate path. */
function openWizard() {
    window.history.pushState({ page: 'agentWizard' }, '', '/app/agent-wizard');
    window.dispatchEvent(new PopStateEvent('popstate'));
}

export default function AgentListSidebar(p: AgentListSidebarProps) {
    const { t } = useTranslation();
    const canCreate = !p.systemMode && p.canManage;
    let body;
    if (p.loading) {
        body = (
            <div className="p-8 text-center text-muted text-sm">
                <div className="spinner-sm mx-auto mb-2"></div>
                Loading...
            </div>
        );
    } else if (p.agents.length === 0) {
        body = (
            <div className="p-8 text-center text-muted text-sm flex flex-col items-center">
                <span className="text-2xl mb-2">🤖</span>
                <p className="mb-3">{t('agent_studio.agent_designer_no_agents_found', 'No agents found')}</p>
                {canCreate && (
                    <button
                        onClick={p.onCreate}
                        className="text-xs font-medium px-3 py-1.5 rounded-lg border bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] transition-all border-[var(--border-default)] text-[var(--text-secondary)]"
                    >
                        {t('agent_studio.agent_designer_create_first_agent', 'Create First Agent')}
                    </button>
                )}
            </div>
        );
    } else {
        body = p.agents.map((agent) => <AgentRow key={agent.id} agent={agent} p={p} />);
    }
    return (
        <div className="w-64 border-r flex flex-col flex-shrink-0 border-[var(--border-subtle)] bg-[var(--bg-primary)]">
            <div className="px-3 h-9 border-b flex items-center justify-between border-[var(--border-default)]">
                <span className="text-[13px] font-semibold tracking-normal text-[var(--text-primary)]">
                    {p.systemMode ? 'System Agents' : 'Agents'}
                </span>
                {canCreate && (
                    <div className="flex items-center gap-1">
                        <button
                            onClick={openWizard}
                            className="px-2 py-1 rounded-lg hover:bg-[var(--item-hover-bg)] transition-colors flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]"
                            title={t('agent_studio.agent_designer_create_with_ai', 'Create with AI')}
                        >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3z"/></svg>
                            {t('agent_studio.agent_designer_ai', 'AI')}
                        </button>
                        <button
                            onClick={p.onCreate}
                            className="p-1 rounded-lg hover:bg-[var(--item-hover-bg)] transition-colors text-[var(--text-tertiary)]"
                            title={t('agent_studio.agent_designer_create_new_agent_empty', 'Create New Agent (empty)')}
                        >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-1.5 py-1">
                {body}
            </div>
        </div>
    );
}

function AgentRow({ agent, p }: { agent: DesignerAgent; p: AgentListSidebarProps }) {
    const { t } = useTranslation();
    const sel = p.selectedAgentId === agent.id;
    const av = pickAgentAvatar(agent);
    // An agent editor may not copy or delete someone else's unpublished agent.
    const locked = Boolean(p.user?.orgRole === 'agent_editor' && agent.owner_id !== p.user?.id && !agent.is_published);
    return (
        <div
            onClick={() => p.onSelect(agent)}
            role="button"
            tabIndex={0}
            className="w-full flex items-center gap-2.5 px-3 h-9 rounded-lg transition-all duration-150 text-left relative group hover:bg-[var(--item-hover-bg)] cursor-pointer"
        >
            {sel && (
                <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full bg-[var(--accent-primary)]" />
            )}
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-base flex-shrink-0 transition-transform ${sel ? 'scale-110' : ''}`}>
                {isImageAvatar(av) ? (
                    <img src={resolveAvatarSrc(av) as string} alt="" className="w-full h-full object-cover" />
                ) : (
                    av || agent.name?.[0]?.toUpperCase()
                )}
            </div>
            <span className={`text-[13px] truncate flex-1 ${sel ? 'font-bold text-black' : 'text-black hover:text-black transition-colors'}`}>
                {agent.name}
            </span>
            {!p.systemMode && p.canManage && (
                <div className="flex items-center gap-0.5 flex-shrink-0">
                    <button
                        onClick={(e) => { e.stopPropagation(); p.onDuplicate(agent); }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-tertiary)] hover:text-blue-400 transition-all rounded disabled:opacity-0 disabled:cursor-not-allowed"
                        title={t('agent_studio.agent_designer_duplicate_agent', 'Duplicate agent')}
                        disabled={locked}
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                        </svg>
                    </button>
                    <button
                        onClick={(e) => { e.stopPropagation(); p.onDelete(agent.id); }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-tertiary)] hover:text-red-500 transition-all rounded disabled:opacity-0 disabled:cursor-not-allowed"
                        title={t('agent_studio.agent_designer_delete_agent', 'Delete agent')}
                        disabled={locked}
                    >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}
