import type { RefObject } from 'react';
import type { projectRouteFromPage } from './projectNavigation';

/** Where Studio is pointed: a section, an optional item and sub-item, plus builder query state. */
export interface StudioRoute {
    section: string;
    id?: string | null;
    sub?: string | null;
    automationKind?: string | null;
    [key: string]: unknown;
}

export interface UseNavigateToPageArgs {
    isMobileRef: RefObject<boolean>;
    user: { isConsumerAccount?: boolean } | null;
    setCurrentPage: (page: string) => void;
    setAdminPath: (path: { seg1: string; seg2: string; seg3: string }) => void;
    setOrgSettingsPath: (path: { seg1: string; seg2: string }) => void;
    setInitialCoworkId: (id: string | null) => void;
    setInitialDocumentId?: (id: string | null) => void;
    setShowProfileMenu: (show: boolean) => void;
    setShowAgentDesigner: (show: boolean) => void;
    setShowAgentWizard: (show: boolean) => void;
    setShowStudio: (show: boolean) => void;
    setStudioRoute: (route: StudioRoute) => void;
    setInitialDesignerAgentId: (id: string | null) => void;
    setFormViewToken: (token: string) => void;
    setAppRunId: (id: string) => void;
    setShowSettings: (show: boolean) => void;
    setShowSkillsPanel: (show: boolean) => void;
    setShowProjects?: (show: boolean) => void;
    setInitialProjectRoute?: (route: ReturnType<typeof projectRouteFromPage>) => void;
}
