/**
 * The sidebar's chat list: which conversations it shows, how they are grouped
 * by date, and how a row is opened, deleted and badged. Split out of
 * Sidebar.jsx without a change in behaviour.
 */
import { isImageAvatar, resolveAvatarSrc, DEFAULT_AGENT_EMOJI } from '../../../utils/agentAvatar';

type Translate = (key: string, fallback?: string) => string;

/** One conversation row as the sidebar reads it. */
export interface SidebarConversation {
    id: string;
    agent_id?: string;
    agent_name?: string;
    project_id?: string | null;
    pinned?: boolean;
    updated_at?: string | null;
    created_at?: string | null;
    /** 'direct' for a direct chat in the all-chats timeline. */
    _source?: string;
    [key: string]: unknown;
}

export interface SidebarAgent {
    id: string;
    name?: string;
    avatar?: string | null;
    [key: string]: unknown;
}

export interface ConversationSource {
    chatHistoryMode: string;
    activeProject?: { id: string } | null;
    allAgentConversations: SidebarConversation[];
    directChatMode?: boolean;
    directConversations: SidebarConversation[];
    groupedConversations?: Array<[unknown, SidebarConversation[]]> | null;
}

/**
 * The conversations the list shows. Inside a project: only that project's
 * chats — that IS the point of selecting one.
 *
 * Outside a project, project chats used to be HIDDEN entirely. Combined with
 * Projects having no URL, a chat filed into a project became very easy to
 * lose: it was absent from every list the user could reach without first
 * remembering which project they had put it in. They are shown now, and
 * ConvRow renders a project chip so the filing is still visible.
 */
export function sidebarConversations(src: ConversationSource): SidebarConversation[] {
    const { activeProject } = src;
    const withinProject = (convs: SidebarConversation[]) => (activeProject
        ? convs.filter(c => c.project_id === activeProject.id)
        : convs);

    // "All Chats" mode — unified timeline from all agents + direct
    if (src.chatHistoryMode === 'all-chats') {
        return withinProject(src.allAgentConversations);
    }
    // Default: per-agent mode
    let convs: SidebarConversation[];
    if (src.directChatMode) convs = src.directConversations;
    else if (!src.groupedConversations) convs = [];
    else convs = src.groupedConversations.flatMap(([, c]) => c);
    return withinProject(convs);
}

export interface ConversationGroup {
    label: string;
    items: SidebarConversation[];
    isPinned?: boolean;
}

/** Time-grouped conversations, with the pinned ones in a group of their own. */
export function groupConversationsByDate(convs: SidebarConversation[], t: Translate, now = new Date()): ConversationGroup[] {
    if (convs.length === 0) return [];
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const groups: Record<'pinned' | 'today' | 'yesterday' | 'month' | 'older', SidebarConversation[]> = {
        pinned: [], today: [], yesterday: [], month: [], older: [],
    };
    convs.forEach(c => {
        // Pinned conversations go to their own group
        if (c.pinned) {
            groups.pinned.push(c);
            return;
        }
        const rawDate = c.updated_at || c.created_at;
        const d = rawDate ? new Date(rawDate) : new Date(0);

        const msgStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        const diffDays = Math.floor((todayStart.getTime() - msgStart.getTime()) / (1000 * 60 * 60 * 24));

        if (diffDays <= 0) groups.today.push(c);
        else if (diffDays === 1) groups.yesterday.push(c);
        else if (diffDays <= 30) groups.month.push(c);
        else groups.older.push(c);
    });
    const out: ConversationGroup[] = [
        { label: t('sidebar.pinned'), items: groups.pinned, isPinned: true },
        { label: t('sidebar.today'), items: groups.today },
        { label: t('sidebar.yesterday'), items: groups.yesterday },
        { label: t('sidebar.last_30_days'), items: groups.month },
        { label: t('sidebar.older'), items: groups.older },
    ];
    return out.filter(g => g.items.length > 0);
}

/** What a delete handler answers: `false` when the conversation is still there, nothing when it cannot say. */
export type DeleteResult = Promise<boolean | void> | boolean | void;

export interface ConversationHandlers {
    chatHistoryMode: string;
    directChatMode?: boolean;
    currentConversation?: { id: string } | null;
    currentDirectConversation?: { id: string } | null;
    onSelectConversation: (c: SidebarConversation) => unknown;
    onSelectDirectConversation: (c: SidebarConversation) => unknown;
    onSelectAllChatsConversation?: ((c: SidebarConversation) => unknown) | null;
    onDeleteConversation: (id: string, agentId?: string) => DeleteResult;
    onDeleteDirectConversation?: ((id: string) => DeleteResult) | null;
}

/** Which row is open, and what opening and deleting one does in each mode. */
export function conversationActions(h: ConversationHandlers) {
    const isAllChats = h.chatHistoryMode === 'all-chats';
    const convIsActive = (c: SidebarConversation) => {
        if (isAllChats) {
            // In all-chats mode, check both agent and direct conversations
            return h.currentDirectConversation?.id === c.id || h.currentConversation?.id === c.id;
        }
        return h.directChatMode ? h.currentDirectConversation?.id === c.id : h.currentConversation?.id === c.id;
    };
    const selectConv = (c: SidebarConversation) => {
        if (isAllChats && h.onSelectAllChatsConversation) {
            h.onSelectAllChatsConversation(c);
            return undefined;
        }
        return h.directChatMode ? h.onSelectDirectConversation(c) : h.onSelectConversation(c);
    };
    // Resolves with what the handler answered: true when the conversation is gone.
    const deleteConv = (conv: SidebarConversation) => {
        if (isAllChats) {
            // In all-chats mode, route to the correct handler based on source
            if (conv._source === 'direct') {
                return h.onDeleteDirectConversation?.(conv.id);
            }
            return h.onDeleteConversation(conv.id, conv.agent_id);
        }
        return h.directChatMode ? h.onDeleteDirectConversation?.(conv.id) : h.onDeleteConversation(conv.id, conv.agent_id);
    };
    return { isAllChats, convIsActive, selectConv, deleteConv };
}

export type AgentBadge = { icon: string; name?: string } | { avatarUrl: string; name?: string };

/** The agent chip a row wears in the all-chats timeline. */
export function agentBadgeFor(c: SidebarConversation, agents: SidebarAgent[]): AgentBadge {
    if (c._source === 'direct') return { icon: '💬', name: 'Direct Chat' };
    const a = agents.find(x => x.id === c.agent_id);
    if (!a) return { icon: DEFAULT_AGENT_EMOJI, name: c.agent_name || 'Agent' };
    return isImageAvatar(a.avatar)
        ? { avatarUrl: resolveAvatarSrc(a.avatar) as string, name: a.name }
        : { icon: a.avatar || DEFAULT_AGENT_EMOJI, name: a.name };
}
