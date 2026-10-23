import type { StudioRoute } from './AgentHub/studioRouteProps';
import type { HubUser } from './AgentHub/useAgentHubData';
import type { ProjectsRoute } from './AgentHub/ProjectsView';

export interface AgentHubProps {
    onNavigate: (page: string) => void;
    currentPage: string;
    initialAgentId?: string | null;
    initialConversationId?: string | null;
    initialDirectConvId?: string | null;
    showSettings?: boolean;
    showAgentDesigner?: boolean;
    initialDesignerAgentId?: string | null;
    showAgentWizard?: boolean;
    showStudio?: boolean;
    studioRoute?: StudioRoute;
    initialCoworkId?: string | null;
    initialDocumentId?: string | null;
    formViewToken?: string | null;
    showProjects?: boolean;
    showSkillsPanel?: boolean;
    user: HubUser | null;
    onUpdateUser?: (patch: Partial<HubUser>) => void;
    onLogout?: () => void;
    onCloseSettings?: () => void;
    onCloseAgentDesigner?: () => void;
    onCloseAgentWizard?: () => void;
    onCloseStudio?: () => void;
    initialProjectRoute?: ProjectsRoute | null;
    onProjectRouteChange?: (projectId: string | null, tab?: string | null, sub?: string | null) => void;
    onCloseProjects?: () => void;
    onCloseSkillsPanel?: () => void;
}
