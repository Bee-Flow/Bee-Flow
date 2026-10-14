import type { Dispatch, SetStateAction } from 'react';
import type { ChatMessage } from '../hooks/useChatEngine/types';
import type { AgentRecord } from './AgentChatView';

/** A conversation as the hub holds it (agent or direct), as far as these actions read it. */
export interface HubConversation {
    id: string | null;
    title?: string;
    updated_at?: string;
    created_at?: string;
    [key: string]: unknown;
}

/** A direct conversation as GET /ai/direct/conversations/:id returns it. */
export interface DirectConversationPayload extends HubConversation {
    sessionSkills?: unknown[];
    activatedSessionSkillIds?: string[];
    completedSessionSkillIds?: string[];
    knowledgeBaseIds?: string[];
    messages?: ChatMessage[];
    model_tier?: string;
}

/** A search hit the search overlay hands back. */
export interface SearchResult {
    kind?: string;
    id: string;
    agent_id?: string;
}

export type Setter<T> = Dispatch<SetStateAction<T>>;

export interface AgentHubActionsDeps {
    agents: AgentRecord[];
    conversations: HubConversation[];
    favorites: string[];
    setFavorites: Setter<string[]>;
    selectedAgent: AgentRecord | null;
    setSelectedAgent: Setter<AgentRecord | null>;
    directChatMode: boolean;
    setDirectChatMode: Setter<boolean>;
    currentConversation: HubConversation | null;
    setCurrentConversation: Setter<HubConversation | null>;
    currentDirectConversation: HubConversation | null;
    setCurrentDirectConversation: Setter<HubConversation | null>;
    setConversations: Setter<HubConversation[]>;
    setDirectConversations: Setter<HubConversation[]>;
    setAllAgentConversations: Setter<HubConversation[]>;
    setMessages: Setter<ChatMessage[]>;
    setDirectSessionSkills: Setter<unknown[]>;
    setDirectActivatedSessionSkillIds: Setter<string[]>;
    setDirectCompletedSessionSkillIds: Setter<string[]>;
    setDirectChatKBIds: Setter<string[]>;
    setNotebookContent: Setter<string>;
    setNotebookSelection: Setter<string>;
    setShowNotebook: Setter<boolean>;
    notebookLinkedId: string | null;
    setNotebookLinkedId: Setter<string | null>;
    setSelectedTier: Setter<string>;
    setDesignMode: Setter<boolean>;
    setShowMarketplace: Setter<boolean>;
    setShowProjectsStore: Setter<boolean>;
    setActiveProjectId: Setter<string | null>;
    setShowSearch: Setter<boolean>;
    isMobile: boolean;
    setSidebarOpen: (open: boolean) => void;
    closeAllOverlays: () => void;
    updateAgentUrl: (agentId: string | null, conversationId: string | null) => void;
    updateDirectChatUrl: (conversationId: string | null) => void;
    refreshAgents: () => void;
    selectConversation: (agentId: string, conversationId: string) => unknown;
    loadDirectConversations: () => void;
    loadModelTiers: () => void;
    onNavigate?: ((page: string) => void) | null;
    confirm: (options: {
        title: string;
        description: string;
        confirmLabel: string;
        destructive?: boolean;
    }) => Promise<boolean>;
    openAtLatest: () => void;
    clearActiveProject: () => void;
}
