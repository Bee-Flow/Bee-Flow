import type { QueryClient } from '@tanstack/react-query';
import { projectKeys, type Project } from '../api/queries/projects';
import { toast } from '../components/shared/Toast';
import scopedStorage from '../utils/scopedStorage';

type Translate = (key: string, fallback?: string) => string;
type Fn = (...args: any[]) => any;

interface AgentLike { id: string; [key: string]: any }
/** A sidebar row: an agent conversation, a direct one, or an "All chats" row. */
interface ConversationRow {
    id: string;
    agent_id?: string | null;
    project_id?: string | null;
    projectId?: string | null;
    _source?: string;
    [key: string]: any;
}
interface ProjectThreadTarget { id: string; type: string; agentId?: string | null }

export interface HubNavigationDeps {
    t: Translate;
    agents: AgentLike[];
    projects: Project[];
    queryClient: QueryClient;
    activeProjectId: string | null;
    selectedAgent: AgentLike | null;
    directChatMode: boolean;
    isMobile: boolean;
    setActiveProject: (project: Project | null) => void;
    setSelectedAgent: (agent: AgentLike | null) => void;
    setDirectChatMode: (on: boolean) => void;
    setSidebarOpen: (open: boolean) => void;
    closeAllOverlays: (options?: { keepPage?: boolean }) => void;
    closeProjects: () => void;
    goToProject: (projectId: string | null, tab?: string | null, sub?: string | null) => void;
    handleSelectAgent: Fn;
    handleDirectChat: Fn;
    handleSelectDirectConversation: Fn;
    selectConversation: Fn;
    loadModelTiers: Fn;
}

/**
 * The chat context that follows a project: which project a page is showing,
 * adopting a conversation's own filing, opening a shared thread, and the
 * sidebar's project entries.
 */
function createProjectNavigation({
    t, agents, projects, queryClient, activeProjectId, selectedAgent, directChatMode,
    setActiveProject, setSelectedAgent, setDirectChatMode,
    closeAllOverlays, closeProjects, goToProject,
    handleSelectAgent, handleDirectChat, handleSelectDirectConversation, selectConversation, loadModelTiers,
}: HubNavigationDeps) {
    // The project a workspace page is showing, for the chat context. The list
    // row is preferred; the page's own detail read covers a list that has not
    // arrived yet.
    const projectForContext = (projectId: string | null) => (projectId
        ? projects.find(p => p.id === projectId) || queryClient.getQueryData(projectKeys.detail(projectId)) || null
        : null);

    // Opening an existing conversation: the chat context is that conversation's
    // OWN filing, never what the previous chat left behind. The sidebar row
    // (`conv.project_id`, the same field the project filter and chip read) is the
    // source: it is on the row at click time, before the conversation GET returns.
    // No project_id means the chat is private, so the context is cleared.
    const adoptConversationProject = (conv: ConversationRow | null | undefined) => {
        setActiveProject(projectForContext(conv?.project_id ?? conv?.projectId ?? null));
    };

    // Opening a shared thread leaves the project page and lands in the chat
    // itself, with the project as the chat context so its instructions and
    // knowledge apply to whatever the member replies.
    const openProjectThread = (thread: ProjectThreadTarget) => {
        const agent = thread.type === 'agent' ? agents.find(a => a.id === thread.agentId) : null;
        if (thread.type === 'agent' && !agent) {
            toast.error(t('sidebar.project_thread_agent_unavailable', 'This chat belongs to an agent you cannot open.'));
            return;
        }
        const project = projectForContext(activeProjectId);
        closeProjects();
        if (agent) {
            handleSelectAgent(agent);
            // After handleSelectAgent, which clears the chat context.
            if (project) setActiveProject(project);
            selectConversation(agent.id, thread.id);
            return;
        }
        if (project) setActiveProject(project);
        if (!directChatMode || selectedAgent) {
            setDirectChatMode(true);
            setSelectedAgent(null);
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
            loadModelTiers();
        }
        handleSelectDirectConversation({ id: thread.id });
    };

    // Pill in the chat header → back to the project's home.
    const openActiveProject = (project: { id: string }) => {
        closeAllOverlays();
        goToProject(project.id);
    };

    const onOpenProject = (p: Project) => {
        // Opening a project also makes it the chat context: the
        // chats started from here on belong to it.
        closeAllOverlays();
        setActiveProject(p);
        goToProject(p.id);
    };

    const onNewChatInProject = (p: Project) => {
        closeProjects();
        handleDirectChat();
        // After handleDirectChat, which clears the context.
        setActiveProject(p);
    };

    const onCreateProject = () => {
        // BFSF-267: these hand-rolled subset closes missed overlays
        // (and Studio/AgentWizard/Notebooks) — route through the
        // single source of truth, then navigate.
        closeAllOverlays();
        goToProject('');
    };

    const onBrowseProjects = () => {
        // The list had no way in at all: it only rendered after the
        // detail view was closed, and nothing opened it directly.
        closeAllOverlays();
        goToProject(null);
    };

    return {
        adoptConversationProject, openProjectThread, openActiveProject,
        onOpenProject, onNewChatInProject, onCreateProject, onBrowseProjects,
    };
}

/** The sidebar's conversation rows: per agent, direct, and "All chats". */
function createConversationNavigation({
    agents, selectedAgent, directChatMode, isMobile,
    setSelectedAgent, setDirectChatMode, setSidebarOpen, closeAllOverlays,
    handleSelectDirectConversation, selectConversation, loadModelTiers,
}: HubNavigationDeps, adoptConversationProject: (conv: ConversationRow | null | undefined) => void) {
    const onSelectConversation = (conv: ConversationRow) => {
        closeAllOverlays();
        adoptConversationProject(conv);
        // Switch agent if the conversation belongs to a different one
        if (conv.agent_id && (!selectedAgent || selectedAgent.id !== conv.agent_id)) {
            const agent = agents.find(a => a.id === conv.agent_id);
            if (agent) {
                setSelectedAgent(agent);
                setDirectChatMode(false);
                scopedStorage.setItem('lastUsedAgentId', agent.id);
                scopedStorage.setItem('lastUsedMode', 'agent');
            }
        }
        selectConversation(conv.agent_id || selectedAgent?.id, conv.id);
        if (isMobile) setSidebarOpen(false);
    };

    const onSelectDirectConversation = (conv: ConversationRow) => {
        // Close every overlay before switching to direct chat —
        // Studio, Agent Wizard, Notebooks, and Webpages were missing
        // here, so picking a direct chat from history while Studio
        // was open updated the URL but kept the editor on screen.
        closeAllOverlays();
        adoptConversationProject(conv);
        // Ensure we're in direct chat mode
        if (!directChatMode) {
            setDirectChatMode(true);
            setSelectedAgent(null);
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
            loadModelTiers();
        }
        handleSelectDirectConversation(conv);
        if (isMobile) setSidebarOpen(false);
    };

    const onSelectAllChatsConversation = (conv: ConversationRow) => {
        // Close every overlay before switching context — Studio, Agent
        // Wizard, Notebooks, Webpages, etc. were all missing here, which
        // is why clicking a chat from history while Studio was open
        // appeared to "do nothing": the conversation loaded behind the
        // Studio overlay. closeAllOverlays() is the single source of
        // truth for this and matches the per-agent path above.
        closeAllOverlays();
        adoptConversationProject(conv);
        if (conv._source === 'direct') {
            // Switch to direct chat mode and open the conversation
            if (!directChatMode) {
                setDirectChatMode(true);
                setSelectedAgent(null);
                loadModelTiers();
                scopedStorage.setItem('lastUsedMode', 'direct-chat');
            }
            handleSelectDirectConversation(conv);
        } else {
            // Switch to the agent and open the conversation
            const agent = agents.find(a => a.id === conv.agent_id);
            if (agent && (!selectedAgent || selectedAgent.id !== agent.id)) {
                setSelectedAgent(agent);
                setDirectChatMode(false);
                scopedStorage.setItem('lastUsedAgentId', agent.id);
                scopedStorage.setItem('lastUsedMode', 'agent');
            } else if (!agent) {
                setDirectChatMode(false);
            }
            selectConversation(conv.agent_id, conv.id);
        }
        if (isMobile) setSidebarOpen(false);
    };

    return { onSelectConversation, onSelectDirectConversation, onSelectAllChatsConversation };
}

/**
 * The hub's navigation closures: the chat context that follows a conversation
 * or project, and the sidebar's select/open handlers. Plain closures, no
 * hooks, rebuilt every render from that render's state — moved verbatim out
 * of AgentHub.jsx.
 */
export function createHubNavigation(deps: HubNavigationDeps) {
    const { adoptConversationProject, ...projectNav } = createProjectNavigation(deps);
    return { ...projectNav, ...createConversationNavigation(deps, adoptConversationProject) };
}
