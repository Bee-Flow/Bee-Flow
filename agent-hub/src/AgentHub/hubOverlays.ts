// Top-level pages rendered ABOVE the overlay branches in the main-content
// ternary (HubMainContent.tsx). A page in this list hides any overlay opened
// while it is on screen, so closeAllOverlays() has to navigate away from it
// too. Keep it in sync with the branch order there — adding a page above the
// overlays without adding it here reintroduces BFSF-267 ("the sidebar item
// does nothing").
const PAGES_ABOVE_OVERLAYS = ['cowork', 'documents', 'apps', 'forms', 'formView'];

type Close = (() => void) | null | undefined;

export interface CloseAllOverlaysDeps {
    onCloseSettings?: Close;
    onCloseAgentDesigner?: Close;
    onCloseAgentWizard?: Close;
    onCloseStudio?: Close;
    onCloseSkillsPanel?: Close;
    currentPage: string;
    onNavigate?: ((page: string) => void) | null;
    setShowMarketplace: (open: boolean) => void;
    setShowProjectsStore: (open: boolean) => void;
    setActiveProjectId: (id: string | null) => void;
    isMobile: boolean;
    setSidebarOpen: (open: boolean) => void;
}

/**
 * Single source of truth for "user navigated somewhere — dismiss every
 * floating overlay first." Without this, opening a chat / notification /
 * marketplace while Studio (or AgentWizard / SkillsPanel / etc) is open
 * leaves the overlay sitting on top of the new content. Every navigation
 * entry point should call this before changing state.
 * `keepPage` is for callers that open something *on top of* the main
 * content (the search palette) rather than replacing it — those have no
 * reason to throw the user off the page they were on.
 *
 * Built per render from that render's props and setters, exactly like the
 * inline closure it replaces.
 */
export function createCloseAllOverlays({
    onCloseSettings, onCloseAgentDesigner, onCloseAgentWizard, onCloseStudio, onCloseSkillsPanel,
    currentPage, onNavigate,
    setShowMarketplace, setShowProjectsStore, setActiveProjectId,
    isMobile, setSidebarOpen,
}: CloseAllOverlaysDeps) {
    return ({ keepPage = false }: { keepPage?: boolean } = {}) => {
        if (onCloseSettings) onCloseSettings();
        if (onCloseAgentDesigner) onCloseAgentDesigner();
        if (onCloseAgentWizard) onCloseAgentWizard();
        if (onCloseStudio) onCloseStudio();
        if (onCloseSkillsPanel) onCloseSkillsPanel();
        // Same trap one level up: Cowork is a top-level PAGE, and it is matched
        // ABOVE the overlay branches in the main ternary. Closing the overlays
        // is not enough — while `currentPage` is still 'cowork' the page keeps
        // winning, so opening the marketplace or search from the sidebar
        // flipped a flag nothing rendered and the click did nothing.
        // Leaving the page is part of closing what's on screen.
        if (!keepPage && PAGES_ABOVE_OVERLAYS.includes(currentPage) && onNavigate) onNavigate('agents');
        setShowMarketplace(false);
        setShowProjectsStore(false);
        setActiveProjectId(null);
        // On phones the sidebar is a full-screen drawer; any navigation/overlay
        // action must dismiss it, otherwise the destination opens behind it.
        if (isMobile) setSidebarOpen(false);
    };
}
