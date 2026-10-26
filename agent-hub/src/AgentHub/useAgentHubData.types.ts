import type { AppUserLike } from '../components/projects/workspace/types';
import type { Dispatch, SetStateAction } from 'react';
import type { Project } from '../api/queries/projects';
import type { SessionSkill } from '../components/skills/sessionSkillState';
import type { GammaPreview } from '../hooks/useChatEngine/sse/gammaPreview';
import type { WebpageRow } from '../api/webpagesWebpageRow.types';
import type { PreviewSelection } from '../pages/webpages/preview/usePreviewToken';

/** A conversation the hub has open: the hub reads only its id. */
export interface IdRef {
    /** null on a fresh chat that has not been saved yet. */
    id: string | null;
    readOnly?: boolean;
    access?: { canPost?: boolean } | null;
    [key: string]: unknown;
}

/** An agent as the hub lists it (`/agents` and `/agents/published` rows). */
export interface AgentLike {
    id: string;
    name?: string;
    description?: string;
    emoji?: string;
    avatar?: string;
    model?: string | null;
    config?: { attachedSkillIds?: string[]; avatar?: string | null; allowCopy?: boolean; enabledIntegrations?: string[] | null; [key: string]: unknown } | null;
    [key: string]: unknown;
}

/** The signed-in user, with the fields the hub reads beyond AppUserLike. */
export interface HubUser extends AppUserLike {
    memoryEnabled?: boolean;
    orgMemoryEnabled?: boolean;
    simpleMode?: boolean;
    role?: string;
    betaFeatures?: string[];
    featureFlags?: { notebooks?: boolean; projects?: boolean; [key: string]: boolean | undefined };
    [key: string]: unknown;
}

/** The address the hub was opened on. */
interface HubRoute {
    initialAgentId: string | null;
    initialConversationId: string | null;
    initialDirectConvId: string | null;
}

/** Which chat is on screen, and the writers that switch it. */
interface HubChatSelection {
    selectedAgent: AgentLike | null;
    setSelectedAgent: Dispatch<SetStateAction<AgentLike | null>>;
    directChatMode: boolean;
    setDirectChatMode: Dispatch<SetStateAction<boolean>>;
    currentConversation: IdRef | null;
    setCurrentConversation: Dispatch<SetStateAction<IdRef | null>>;
    currentDirectConversation: IdRef | null;
    setCurrentDirectConversation: Dispatch<SetStateAction<IdRef | null>>;
    selectedTier: string;
    setSelectedTier: Dispatch<SetStateAction<string>>;
    activeProject: Project | null;
    coworkMode: string;
    setCoworkMode: Dispatch<SetStateAction<string>>;
}

/** The skills and knowledge bases a turn carries. */
interface HubTurnContext {
    activeSkillIds: string[];
    directSessionSkills: SessionSkill[];
    setDirectSessionSkills: Dispatch<SetStateAction<SessionSkill[]>>;
    directActivatedSessionSkillIds: string[];
    setDirectActivatedSessionSkillIds: Dispatch<SetStateAction<string[]>>;
    setDirectCompletedSessionSkillIds: Dispatch<SetStateAction<string[]>>;
    directChatKBIds: string[];
    setDirectChatKBIds: Dispatch<SetStateAction<string[]>>;
}

/** The notebook panel's state, as the engine and the conversation loaders use it. */
interface HubNotebookPanel {
    notebooksEnabled: boolean;
    notebookContent: string;
    setNotebookContent: Dispatch<SetStateAction<string>>;
    notebookSelection: string;
    setNotebookSelection: Dispatch<SetStateAction<string>>;
    showNotebook: boolean;
    setShowNotebook: Dispatch<SetStateAction<boolean>>;
    setNotebookLinkedId: Dispatch<SetStateAction<string | null>>;
}

interface HubGammaPanel {
    setShowGammaPreview: Dispatch<SetStateAction<boolean>>;
    setGammaPreview: Dispatch<SetStateAction<(GammaPreview & { error?: string; }) | null>>;
}

/** The webpage / document side panel a direct turn can be attached to. */
interface HubWebpagePanel {
    sidePanelWebpageId: string | null;
    sidePanelWebpage: WebpageRow | null;
    sidePanelWebpageFiles: { html: string; css: string; js: string; };
    setSidePanelWebpageFiles: Dispatch<SetStateAction<{ html: string; css: string; js: string; }>>;
    setSidePanelReloadKey: Dispatch<SetStateAction<number>>;
    sidePanelDocumentId: string | null;
    attachedWebpageSelection: PreviewSelection | null;
}

/** The loaders of the list slices, for the flows that refresh a list. */
interface HubListLoaders {
    refreshAgents: () => Promise<AgentLike[] | null>;
    loadConversations: (agentId: string) => Promise<void>;
    loadDirectConversations: () => Promise<void>;
    loadLabels: () => Promise<void>;
    loadModelTiers: () => Promise<void>;
}

export interface UseAgentHubDataArgs {
    user: HubUser | null;
    route: HubRoute;
    chat: HubChatSelection;
    skills: HubTurnContext;
    notebook: HubNotebookPanel;
    gamma: HubGammaPanel;
    webpage: HubWebpagePanel;
    lists: HubListLoaders;
}
