import type { StudioNavUser } from '../admin/Studio/studioNav';
import type { ConversationHandlers, ConversationSource, SidebarAgent, SidebarConversation } from './sidebar/sidebarConversations';
import type React from 'react';
import type { Project } from '../../api/queries/projects';
import type { ConvRowHandlers } from './sidebar/RecentChats';

export interface SidebarUser extends StudioNavUser {
    id?: string;
    username?: string;
    displayName?: string;
    avatar?: string | null;
    avatarType?: string | null;
    permissions?: string[] | null;
    simpleMode?: boolean;
    featureFlags?: { projects?: boolean };
    organization?: { logo?: string; name?: string } | null;
}

export interface ProjectRailRoute {
    projectId: string;
    tab: string | null;
    onSelectTab: (tab: string | null | undefined) => void;
    onBack: () => void;
    onOpenProject: (id: string | null) => void;
    onOpenSearch: () => void;
    notebooksEnabled: boolean;
}

export interface SidebarProps extends ConversationHandlers, ConversationSource {
    isOpen: boolean;
    isMobile?: boolean;
    onClose?: () => void;
    toggleSidebar: () => void;
    onNewChat?: () => void;
    selectedAgent?: { id: string } | null;
    onClearSelection?: () => void;
    favorites?: string[];
    agents?: SidebarAgent[];
    onSelectAgent: (agent: SidebarAgent) => void;
    onOpenMarketplace?: (() => void) | null;
    onOpenSearch?: (() => void) | null;
    hasPermission?: ((permission: string) => boolean) | null;
    user?: SidebarUser | null;
    onLogout?: React.MouseEventHandler<HTMLButtonElement>;
    onNavigate: (page: string) => void;
    currentPage: string;
    studioRoute?: { section?: string | null } | null;
    projectRail?: ProjectRailRoute | null;
    showSettings?: boolean;
    showAgentDesigner?: boolean;
    showSkillsPanel?: boolean;
    showMarketplace?: boolean;
    onDirectChat?: (() => void) | null;
    directChatMode: boolean;
    directConversations: SidebarConversation[];
    onToggleFavorite?: (agentId: string) => void;
    projects?: Project[];
    onOpenProject?: (project: Project) => void;
    onNewChatInProject?: (project: Project) => void;
    onCreateProject?: () => void;
    onBrowseProjects?: () => void;
    conversationLabels?: ConvRowHandlers['conversationLabels'];
    onRenameConversation?: ConvRowHandlers['onRenameConversation'];
    onPinConversation?: ConvRowHandlers['onPinConversation'];
    onLabelConversation?: ConvRowHandlers['onLabelConversation'];
    onDeleteLabel?: ConvRowHandlers['onDeleteLabel'];
    onEditLabel?: ConvRowHandlers['onEditLabel'];
    onCreateLabel?: ConvRowHandlers['onCreateLabel'];
    onMoveToProject?: ConvRowHandlers['onMoveToProject'];
    onShareToProject?: ConvRowHandlers['onShareToProject'];
}

/** SidebarProps once withDefaults has filled the props that have a default. */
export type ResolvedSidebarProps = SidebarProps & Required<Pick<SidebarProps, 'isMobile' | 'favorites' | 'agents' | 'hasPermission' | 'projects' | 'conversationLabels' | 'showSettings' | 'showAgentDesigner' | 'showSkillsPanel' | 'showMarketplace'>>;
