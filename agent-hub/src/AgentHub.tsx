import { useQueryClient } from '@tanstack/react-query';
import React, { useState, useEffect, useEffectEvent, useRef, useCallback, Suspense } from 'react';
import ChatSidePanels from './AgentHub/ChatSidePanels';
import { AgentDesignerPanel, LazyFallback, MemoryPanel } from './AgentHub/hubLazySlots';
import HubMainContent from './AgentHub/HubMainContent';
import { createHubNavigation } from './AgentHub/hubNavigation';
import { createCloseAllOverlays } from './AgentHub/hubOverlays';
import useAgentHubActions from './AgentHub/useAgentHubActions';
import useAgentHubData from './AgentHub/useAgentHubData';
import useComposerMode from './AgentHub/useComposerMode';
import useConversationMeta from './AgentHub/useConversationMeta';
import useDirectChatEvents from './AgentHub/useDirectChatEvents';
import useProjectChatStart from './AgentHub/useProjectChatStart';
import useSidePanelState from './AgentHub/useSidePanelState';
import { useProjectsQuery, type Project } from './api/queries/projects';
import { usesProjectRail } from './authedApp/appRoutes';
import { useLicenseContext } from './components/licensing/LicenseContext';
import { ProjectLiveProvider } from './components/projects/workspace/ProjectLiveContext';
import useConfirm from './components/shared/useConfirm';
import SearchOverlay from './components/shell/SearchOverlay';
import Sidebar from './components/shell/Sidebar';
import { useTranslation } from './hooks/useTranslation';
import { useViewport } from './hooks/useViewport';
import { rememberStudioItem } from './utils/studioRecents';
import { whenMayNavigate } from './utils/unsavedNavigation';
import type { ConversationRow, ConversationLabel } from './AgentHub/useConversationMeta';
import type { AgentLike, HubUser, IdRef } from './AgentHub/useAgentHubData';
import type { ProjectsRoute } from './AgentHub/ProjectsView';
import type { SessionSkill } from './components/skills/sessionSkillState';

declare global {
    interface Window {
        __beeflowSimpleMode?: boolean;
    }
}

// The lazy slots (admin / studio / notebooks / marketplaces) and their shared
// Suspense fallback live in AgentHub/hubLazySlots.tsx; the main-content slot
// and its order in AgentHub/HubMainContent.tsx; the pages that outrank the
// overlays (PAGES_ABOVE_OVERLAYS, BFSF-267) in AgentHub/hubOverlays.ts.

// One stable empty list, so a hub without projects does not hand the sidebar
// a new array on every render.
const NO_PROJECTS: never[] = [];

interface AgentHubProps {
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
    studioRoute?: { section: string; id: string | null; };
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

const AgentHub = ({
    onNavigate, user, onUpdateUser, onLogout, currentPage,
    initialAgentId = null, initialConversationId = null, initialDirectConvId = null,
    showSettings = false, onCloseSettings,
    showAgentDesigner = false, onCloseAgentDesigner, initialDesignerAgentId = null,
    showAgentWizard = false, onCloseAgentWizard,
    showStudio = false, studioRoute = { section: 'agents', id: null }, onCloseStudio,
    initialCoworkId = null,
    initialDocumentId = null,
    // Which published form /app/forms/:token is showing (page key 'formView').
    formViewToken = null,
    // Projects is URL-driven now. `initialProjectRoute` is null when we are not
    // on a projects path, { projectId: null } for the list, and
    // { projectId, tab, sub } for one project (a tab, and optionally one item
    // inside it) — so the list and a workspace are distinct destinations
    // instead of the list only appearing once the detail view is closed.
    showProjects = false, initialProjectRoute = null, onProjectRouteChange, onCloseProjects,
    showSkillsPanel = false, onCloseSkillsPanel,
}: AgentHubProps) => {
    // Share/collaboration copy is user-facing and Dutch-translated, so it goes
    // through the same dictionary as the rest of the UI rather than being
    // hardcoded here.
    const { t } = useTranslation();
    // Permission helper - checks if user has a specific permission
    const hasPermission = (perm: string) => {
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    };

    // Viewport detection — shared hook (see hooks/useViewport.js).
    //   isMobile  <768  — hamburger/overlay patterns
    //   isCompact 768–1279 — 13" laptops: auto-collapse sidebar, notebook as drawer
    //   isDesktop >=1280  — full split-pane layout
    const { isMobile, isCompact } = useViewport();

    // Auto-enable Simple Mode on phone-sized screens (<768px). We do NOT persist
    // this: the stored per-user preference (user.simpleMode) is the desktop
    // choice and stays untouched — on mobile we force the simplified surface on
    // top of it so Studio / Notebooks / Webpages / model-tier controls (cramped
    // or unusable on a phone) stay hidden. Sidebar + InputArea derive the same
    // value from the `isMobile` prop they already receive, and the broadcast
    // effect below propagates it to deep descendants (e.g. MessageItem). The
    // Settings toggle keeps reading the raw `user.simpleMode` so it still
    // reflects the real saved preference.
    const simpleMode = !!user?.simpleMode || isMobile;

    // ── Chat ⇄ Cowork ── (AgentHub/useComposerMode.ts)
    const { coworkMode, setCoworkMode, inCoworkMode, coworkComposer, setCoworkModeForAgent } = useComposerMode();


    // Notebook layout: split-pane sibling column at every breakpoint above
    // mobile. On compact (13" laptops) it takes a fixed ~420 px width so the
    // chat keeps usable room; on desktop it splits 50/50 with the chat. No
    // floating drawer or scrim — the notebook simply sits to the right of
    // the chat, the way users expect a split workspace.
    const notebookWrapperClass = isCompact
        ? "w-[min(420px,50%)] min-w-0 flex-shrink flex flex-col h-full border-l border-[var(--border-subtle)] animate-in slide-in-from-right duration-300"
        : "w-1/2 min-w-[min(400px,50%)] flex flex-col h-full border-l border-[var(--border-subtle)] animate-in slide-in-from-right duration-300";

    // Feature flags
    // Simple Mode also forces notebooks off — the toggle in /settings/simple-mode
    // hides the panel + buttons until the user turns Simple Mode back off.
    // `hasLicenseFeature('notebooks')` mirrors the sidebar + the `/api/notebooks*`
    // licence gate so the workspace notebook buttons / panel / open-in-notebook
    // wiring all disappear when the org's plan doesn't grant notebooks. The
    // `use_notebooks` RBAC permission check ALSO mirrors the sidebar
    // (Sidebar.jsx) and the server router guard (requirePermission) so a user
    // whose role lacks the permission doesn't see the in-chat notebook entry
    // points either — previously these buttons showed without that check.
    const { hasFeature: hasLicenseFeature } = useLicenseContext();
    const canUseNotebooksPerm = !!(user?.permissions?.includes('all') || user?.permissions?.includes('use_notebooks'));
    const notebooksEnabled = !simpleMode && user?.featureFlags?.notebooks !== false && hasLicenseFeature('notebooks') && canUseNotebooksPerm;
    const projectsEnabled = user?.featureFlags?.projects !== false;

    // Core State
    const [agents, setAgents] = useState<AgentLike[]>([]);
    const [agentCategories, setAgentCategories] = useState<{ id: string; name: string; description: string; emoji: string }[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<AgentLike | null>(null);
    const [conversations, setConversations] = useState<ConversationRow[]>([]);
    const [currentConversation, setCurrentConversation] = useState<IdRef | null>(null);
    // Sidebar defaults to its full-width state only on true desktops (>=1280).
    // Default to expanded on anything wider than a tablet; only small screens
    // start in icon-rail mode. The user can still toggle it.
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
    const [studioFullscreen, setStudioFullscreen] = useState(false);
    const [showProjectsStore, setShowProjectsStore] = useState(false);
    // null = closed, '' = create-new, otherwise an existing project id
    const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
    // Whether the project search panel is open: the rail's search pill sets it,
    // the workspace page renders the panel.
    const [projectSearchOpen, setProjectSearchOpen] = useState(false);
    // Collapse the main sidebar to its icon-rail whenever Studio is open OR a
    // child explicitly asks for fullscreen (legacy path used by AgentStudio's
    // edit mode). Stash the prior expanded/collapsed state so we can restore
    // it when the user navigates back out of Studio.
    // A project page does the same: its own rail replaces the sidebar, so the
    // sidebar's open state is stashed and restored exactly as for Studio.
    const projectRailActive = usesProjectRail(currentPage, showProjectsStore ? activeProjectId : null);
    // On a phone the sidebar is an overlay and the rail never replaces it, so
    // there is nothing to stash there.
    const collapseForRail = showStudio || studioFullscreen || (projectRailActive && !isMobile);
    // A search panel left open (error page, browser Back) must not outlive its project.
    useEffect(() => { setProjectSearchOpen(false); }, [activeProjectId]);
    const sidebarOpenBeforeStudioRef = useRef<boolean>(null);
    // An Effect Event: it snapshots `sidebarOpen` at the moment the flag flips,
    // and must not run again when the user toggles the sidebar inside Studio.
    const syncSidebarToStudio = useEffectEvent((collapse: boolean) => {
        if (collapse) {
            if (sidebarOpenBeforeStudioRef.current === null) {
                sidebarOpenBeforeStudioRef.current = sidebarOpen;
            }
            if (sidebarOpen) setSidebarOpen(false);
        } else if (sidebarOpenBeforeStudioRef.current !== null) {
            const restore = sidebarOpenBeforeStudioRef.current;
            sidebarOpenBeforeStudioRef.current = null;
            if (restore) setSidebarOpen(true);
        }
    });
    useEffect(() => { syncSidebarToStudio(collapseForRail); }, [collapseForRail]);
    const {
        notebookContent, setNotebookContent,
        notebookSelection, setNotebookSelection,
        showNotebook, setShowNotebook,
        notebookLinkedId, setNotebookLinkedId,
        showGammaPreview, setShowGammaPreview,
        gammaPreview, setGammaPreview,
        sidePanelWebpageId, setSidePanelWebpageId,
        sidePanelWebpage, setSidePanelWebpage,
        sidePanelWebpageFiles, setSidePanelWebpageFiles,
        attachedWebpageSelection, setAttachedWebpageSelection,
        sidePanelReloadKey, setSidePanelReloadKey,
        sidePanelDocumentId,
        webpagePickerOpen, setWebpagePickerOpen,
        webpageButtonRef, webpageButtonRefDirect,
        openWebpageInSidePanel, closeWebpagePanel, clearWebpageSelection,
        openDocumentInSidePanel, closeDocumentPanel,
    } = useSidePanelState();
    // Same unified entitlements snapshot as the /api/webpages gate (hasLicenseFeature
    // now delegates to EntitlementsContext.can) — mirrors the notebooks gate above.
    const canUseWebpagesSide = !simpleMode && hasLicenseFeature('webpages');

    // Remember which Studio item you were last in, for the sidebar's
    // "recently edited" panels. Recorded HERE rather than in each of the eight
    // editors, because this is the one place every route into a Studio item
    // passes through — sidebar click, in-app navigation, deep link and refresh
    // alike. Nothing is recorded for a bare section (no id).
    useEffect(() => {
        if (!showStudio) return;
        if (!studioRoute?.section || !studioRoute?.id) return;
        rememberStudioItem(studioRoute.section, studioRoute.id);
    }, [showStudio, studioRoute?.section, studioRoute?.id]);

    // The onboarding tour asks us to expand the sidebar before it spotlights a
    // sidebar nav item (the rail auto-collapses on narrow laptops / in Studio,
    // which would hide the highlight target). Desktop only.
    useEffect(() => {
        const onEnsureSidebar = () => { if (!isMobile) setSidebarOpen(true); };
        window.addEventListener('beeflow:tour-ensure-sidebar-open', onEnsureSidebar);
        return () => window.removeEventListener('beeflow:tour-ensure-sidebar-open', onEnsureSidebar);
    }, [isMobile]);

    // When Simple Mode is turned ON, force-close any open side panels — the
    // panel buttons disappear in the same frame so we'd otherwise leave the
    // panel orphaned on screen with no way to close it. Also force the model
    // tier back to 'auto' since the selector is hidden.
    useEffect(() => {
        const on = simpleMode;
        // Broadcast so deep descendants (e.g. MessageItem) can hide
        // surface-level features like the "How I got this answer" panel
        // without prop-drilling. Mirrors the chatHistoryMode pattern.
        if (typeof window !== 'undefined') {
            window.__beeflowSimpleMode = on;
            window.dispatchEvent(new CustomEvent('beeflow:simpleModeChanged', { detail: on }));
        }
        if (on) {
            setShowNotebook(false);
            setShowGammaPreview(false);
            setSidePanelWebpageId(null);
            setSidePanelWebpage(null);
            setSelectedTier('auto');
        }
    }, [simpleMode, setShowNotebook, setShowGammaPreview, setSidePanelWebpageId, setSidePanelWebpage]);

    // The reasoning panel used to be broadcast from here, gated on platform
    // super-admin (BFSF-253). It is now on for everyone — MessageItem takes a
    // `showReasoning` prop that defaults to true, and only the public embed
    // page opts out. Nothing to broadcast, so the effect is gone.

    // Direct Chat State
    const [directChatMode, setDirectChatMode] = useState(() => window.innerWidth < 768);
    const [selectedTier, setSelectedTier] = useState('auto');
    const [modelTiers, setModelTiers] = useState<{}>({});
    const [directConversations, setDirectConversations] = useState<ConversationRow[]>([]);
    const [currentDirectConversation, setCurrentDirectConversation] = useState<IdRef | null>(null);
    const [chatInput, setChatInput] = useState('');

    useEffect(() => {
        setShowGammaPreview(false);
        setGammaPreview(null);
    }, [directChatMode, setShowGammaPreview, setGammaPreview]);

    // Projects State. `projects` is the collaborative workspaces this person
    // belongs to (Studio Solutions are listed in Studio only), read through
    // the data layer so a create, rename or delete anywhere refreshes the
    // sidebar too. `activeProject` is the CHAT CONTEXT: the project whose
    // instructions and knowledge the next turn uses, and where a new chat is
    // filed. It is derived against the list, so a project that was deleted or
    // that this person was removed from drops out of the context by itself.
    const queryClient = useQueryClient();
    const projectsQuery = useProjectsQuery('workspace', projectsEnabled);
    const projects = (projectsEnabled && projectsQuery.data) || NO_PROJECTS;
    const [activeProject, setActiveProject] = useState<Project | null>(null);
    const activeProjectLive = !activeProject ? null
        : projectsQuery.isSuccess ? (projects.find(p => p.id === activeProject.id) || null)
            : activeProject;

    // The URL is the source of truth for which projects view is open. Keeping
    // these in sync one-way (route → state) means a reload, a deep link and a
    // back-button press all land in the same place, which none of them did
    // while this was local-only state.
    useEffect(() => {
        if (!showProjects) {
            setShowProjectsStore(false);
            return;
        }
        setShowProjectsStore(true);
        // `undefined` route id means the list; a real id means that project.
        setActiveProjectId(initialProjectRoute?.projectId ?? null);
        // Keyed on the route OBJECT, not only its id: the host hands over a new
        // one for every move (back/forward included), and Back to the same
        // project after a chat had hidden the page must still bring it back.
    }, [showProjects, initialProjectRoute]);

    // Navigate by changing the URL, not by flipping local booleans, so history
    // records the move. Falls back to local state when the host didn't wire the
    // callback (embedded/preview renders of AgentHub).
    // The local view is set as well: the route may not change at all (the same
    // project clicked again after a chat hid the page), and then nothing else
    // would bring the page back.
    const goToProject = useCallback((projectId: string | null, tab?: string | null | undefined, sub?: string | null | undefined) => whenMayNavigate(() => {
        // Ask first: a cancelled "unsaved settings" prompt must leave view and
        // URL where they are. The workspace clears its dirty flag when the
        // reader confirms, so the host's own check afterwards passes silently.
        setProjectSearchOpen(false);
        setShowProjectsStore(true);
        setActiveProjectId(projectId ?? null);
        if (onProjectRouteChange) onProjectRouteChange(projectId, tab, sub);
    }), [onProjectRouteChange]);

    const closeProjects = useCallback(() => {
        if (onCloseProjects) onCloseProjects();
        else { setShowProjectsStore(false); setActiveProjectId(null); }
    }, [onCloseProjects]);

    // Conversation Labels State
    const [conversationLabels, setConversationLabels] = useState<ConversationLabel[]>([]);

    // Chat History Mode — "per-agent" (default) or "all-chats" (unified timeline).
    // Initial value is null because scopedStorage isn't populated until App.jsx's
    // setCurrentUser fires. The useEffect below hydrates on first render.
    const [chatHistoryMode, setChatHistoryMode] = useState('per-agent');
    const [allAgentConversations, setAllAgentConversations] = useState<ConversationRow[]>([]);

    // Skills State (must be declared before useChatEngine so it can reference activeSkillIds)
    const [activeSkillIds, setActiveSkillIds] = useState<string[]>([]);
    const [directSessionSkills, setDirectSessionSkills] = useState<SessionSkill[]>([]);
    const [directActivatedSessionSkillIds, setDirectActivatedSessionSkillIds] = useState<string[]>([]);
    // Knowledge bases attached to the current direct chat. Persisted on the
    // conversation since C3: the detail GET hands back the authorised list on
    // every load, and the composer writes changes through PATCH — so this is a
    // mirror of the server's column, not a session-local preference.
    const [directChatKBIds, setDirectChatKBIds] = useState<string[]>([]);
    const [directCompletedSessionSkillIds, setDirectCompletedSessionSkillIds] = useState<string[]>([]);

    // The data/engine core (per-user hydration, chat engine wiring, UI and
    // marketplace state, URL helpers, scroll effects, agent/KB stores, startup
    // logic and selectConversation) lives in useAgentHubData — moved verbatim,
    // called from the exact position the inline hooks occupied so hook order
    // and state ownership (AgentHub's fiber) are unchanged.
    const {
        messages, setMessages, isLoading, sendMessage, stopGenerating, retryMessage, editAndRegenerate,
        turnConversation, chatSignals,
        conversationStarted, handleVoiceTurnComplete,
        handleToggleSkill, agentAttachedSkillIds,
        designMode, setDesignMode,
        showMarketplace, setShowMarketplace,
        directChatKbs,
        showSearch, setShowSearch,
        showMemoryPanel, setShowMemoryPanel,
        showAgentMenu, setShowAgentMenu,
        favorites, setFavorites,
        messagesEndRef, messagesContainerRef, shouldForceScrollRef, openAtLatest,
        updateAgentUrl, updateDirectChatUrl,
        refreshAgents,
        loadConversations, selectConversation,
        loadDirectConversations, loadModelTiers,
    } = useAgentHubData({
        user, initialAgentId, initialConversationId, initialDirectConvId,
        showSettings, showAgentDesigner, showAgentWizard, showStudio, showSkillsPanel,
        coworkMode, setCoworkMode,
        selectedAgent, setSelectedAgent,
        directChatMode, setDirectChatMode,
        currentConversation, setCurrentConversation,
        currentDirectConversation, setCurrentDirectConversation,
        setConversations, setDirectConversations, setConversationLabels,
        setAgents, setAgentCategories, setModelTiers,
        selectedTier, setSelectedTier,
        activeProject: activeProjectLive,
        activeSkillIds, setActiveSkillIds, setChatHistoryMode,
        directSessionSkills, setDirectSessionSkills,
        directActivatedSessionSkillIds, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds,
        directChatKBIds, setDirectChatKBIds,
        notebooksEnabled,
        notebookContent, setNotebookContent, notebookSelection, setNotebookSelection,
        showNotebook, setShowNotebook, setNotebookLinkedId,
        setShowGammaPreview, setGammaPreview,
        sidePanelWebpageId, sidePanelWebpage, sidePanelWebpageFiles, setSidePanelWebpageFiles, setSidePanelReloadKey,
        sidePanelDocumentId,
        attachedWebpageSelection,
        setSidebarOpen,
        setShowProjectsStore, setActiveProjectId,
    });


    // "All Chats" aggregation + window-event listeners (chat-history-mode
    // switch, NotificationCenter's "Open in Direct Chat"). Same hook order as
    // the inline effects it replaces.
    useDirectChatEvents({
        chatHistoryMode, setChatHistoryMode, setAllAgentConversations,
        isMobile, setSidebarOpen,
        setDirectChatMode, setSelectedAgent,
        setCurrentConversation, setCurrentDirectConversation, setMessages,
        setNotebookContent, setNotebookSelection, setShowNotebook, setNotebookLinkedId,
        updateDirectChatUrl, loadDirectConversations, loadModelTiers, selectConversation,
    });

    // Non-admins without the skills-beta feature get a filtered modelTiers
    // response (the server omits 'standard'). If our persisted/restored
    // selectedTier is one the server no longer returns, fall back to 'auto'
    // so downstream reads like modelTiers[selectedTier] don't see undefined.
    useEffect(() => {
        const keys = Object.keys(modelTiers || {});
        if (keys.length === 0) return;
        if (!keys.includes(selectedTier)) {
            setSelectedTier(keys.includes('auto') ? 'auto' : keys[0]);
        }
    }, [modelTiers, selectedTier]);

    // Populate a read-only diagnostics bag on window so ErrorBoundary can
    // include role/tier context in crash reports without having to plumb
    // hook state through the boundary.
    useEffect(() => {
        try {
            window.__APP_DIAGNOSTICS__ = {
                userRole: user?.isAdmin ? 'admin' : (user?.role || 'user'),
                featureFlags: {
                    permissions: Array.isArray(user?.permissions) ? user.permissions : [],
                    betaFeatures: Array.isArray(user?.betaFeatures) ? user.betaFeatures : [],
                    selectedTier,
                    modelTierKeys: Object.keys(modelTiers || {}),
                },
            };
        } catch (_) { /* ignore */ }
    }, [user, selectedTier, modelTiers]);

    // Sidebar-row conversation bookkeeping: project filing/sharing, rename,
    // pin, labels. Plain closures, no hooks — moved verbatim.
    const { confirm, confirmDialog } = useConfirm();
    const {
        handleShareToProject, handleMoveToProject,
        handleRenameConversation, handlePinConversation, handleLabelConversation,
        handleCreateLabel, handleDeleteLabel, handleEditLabel,
    } = useConversationMeta({
        t, directChatMode, selectedAgent,
        loadDirectConversations, loadConversations,
        setDirectConversations, setConversations, setConversationLabels,
        confirm,
    });

    // Single source of truth for "user navigated somewhere — dismiss every
    // floating overlay first" (AgentHub/hubOverlays.ts). Every navigation
    // entry point should call this before changing state.
    const closeAllOverlays = createCloseAllOverlays({
        onCloseSettings, onCloseAgentDesigner, onCloseAgentWizard, onCloseStudio, onCloseSkillsPanel,
        currentPage, onNavigate,
        setShowMarketplace, setShowProjectsStore, setActiveProjectId,
        isMobile, setSidebarOpen,
    });

    // Navigation-level handlers (select agent/conversation, direct chat, new
    // chat, delete, search routing, favourites, unpublish, notebook save).
    // Plain closures, no hooks — moved verbatim; closeAllOverlays is built
    // just above (pinned by AgentHub.overlayOrder.test.js) and is passed in.
    const {
        handleSelectAgent, handleDirectChat,
        handleSelectDirectConversation, handleDeleteDirectConversation,
        handleNewChat, handleDeleteConversation, handleSearchResultSelect,
        getGroupedConversations, handleToggleFavorite, handleUnpublishAgent,
        saveNotebook, handleOpenInNotebook,
    } = useAgentHubActions({
        agents, conversations, favorites, setFavorites,
        selectedAgent, setSelectedAgent, directChatMode, setDirectChatMode,
        currentConversation, setCurrentConversation,
        currentDirectConversation, setCurrentDirectConversation,
        setConversations, setDirectConversations, setAllAgentConversations,
        setMessages, setDirectSessionSkills, setDirectActivatedSessionSkillIds, setDirectCompletedSessionSkillIds,
        setDirectChatKBIds,
        setNotebookContent, setNotebookSelection, setShowNotebook,
        notebookLinkedId, setNotebookLinkedId,
        setSelectedTier, setDesignMode,
        setShowMarketplace,
        setShowProjectsStore, setActiveProjectId, setShowSearch,
        isMobile, setSidebarOpen, closeAllOverlays,
        updateAgentUrl, updateDirectChatUrl,
        refreshAgents, selectConversation, loadDirectConversations, loadModelTiers,
        onNavigate,
        confirm,
        openAtLatest,
        clearActiveProject: () => setActiveProject(null),
    });

    // ── Project workspace → chat ─────────────────────────────────────────
    // A chat started from a project's composer: the project becomes the chat
    // context, a new direct or agent chat opens, the first message is sent and,
    // when asked, the new conversation is shared with the project's members.
    const { startChat: startProjectChat } = useProjectChatStart({
        t, agents,
        setActiveProject,
        leaveProjectsPage: closeProjects,
        openDirectChat: handleDirectChat,
        openAgentChat: handleSelectAgent,
        sendMessage, setChatInput,
        activeProjectId: activeProjectLive?.id ?? null,
        isLoading, directChatMode,
        selectedAgentId: selectedAgent?.id ?? null,
        directConversationId: currentDirectConversation?.id ?? null,
        agentConversationId: currentConversation?.id ?? null,
        messages,
        turnConversation,
    });

    // Chat context that follows a conversation or project, and the sidebar's
    // select/open handlers (AgentHub/hubNavigation.ts).
    const {
        openProjectThread, openActiveProject,
        onSelectConversation, onSelectDirectConversation, onSelectAllChatsConversation,
        onOpenProject, onNewChatInProject, onCreateProject, onBrowseProjects,
    } = createHubNavigation({
        t, agents, projects, queryClient, activeProjectId, selectedAgent, directChatMode, isMobile,
        setActiveProject, setSelectedAgent, setDirectChatMode, setSidebarOpen,
        closeAllOverlays, closeProjects, goToProject,
        handleSelectAgent, handleDirectChat, handleSelectDirectConversation, selectConversation, loadModelTiers,
    });


    if (designMode) {
        return (
            <Suspense fallback={<LazyFallback />}>
                <AgentDesignerPanel
                    agent={selectedAgent}
                    user={user}
                    onClose={() => setDesignMode(false)}
                    onSave={(newAgent: AgentLike | null) => {
                        if (newAgent && newAgent.id) {
                            setSelectedAgent(newAgent);
                            refreshAgents();
                        }
                    }}
                    onDelete={() => {
                        setSelectedAgent(null);
                        setDesignMode(false);
                        refreshAgents();
                    }}
                />
            </Suspense>
        );
    }

    // Right-hand split column shared by the agent-chat and direct-chat layouts.
    // The notebook / gamma-preview / webpage panels are mutually exclusive and
    // render identically in both modes apart from which conversation id the
    // notebook binds to (and the onAskAI debug log's mode tag).
    const renderSidePanels = (mode: 'agent' | 'direct') => (
        <ChatSidePanels
            mode={mode}
            isMobile={isMobile}
            notebooksEnabled={notebooksEnabled}
            notebookWrapperClass={notebookWrapperClass}
            showNotebook={showNotebook}
            setShowNotebook={setShowNotebook}
            showGammaPreview={showGammaPreview}
            setShowGammaPreview={setShowGammaPreview}
            notebookContent={notebookContent}
            setNotebookContent={setNotebookContent}
            setNotebookSelection={setNotebookSelection}
            saveNotebook={saveNotebook}
            handleOpenInNotebook={handleOpenInNotebook}
            isLoading={isLoading}
            selectedAgent={selectedAgent}
            sendMessage={sendMessage}
            user={user}
            currentConversation={currentConversation}
            currentDirectConversation={currentDirectConversation}
            notebookLinkedId={notebookLinkedId}
            setNotebookLinkedId={setNotebookLinkedId}
            gammaPreview={gammaPreview}
            setGammaPreview={setGammaPreview}
            sidePanelWebpageId={sidePanelWebpageId}
            closeWebpagePanel={closeWebpagePanel}
            setSidePanelWebpage={setSidePanelWebpage}
            setSidePanelWebpageFiles={setSidePanelWebpageFiles}
            setAttachedWebpageSelection={setAttachedWebpageSelection}
            sidePanelReloadKey={sidePanelReloadKey}
            onNavigate={onNavigate}
            sidePanelDocumentId={sidePanelDocumentId}
            closeDocumentPanel={closeDocumentPanel}
        />
    );

    return (
        <Suspense fallback={<LazyFallback />}>
        <ProjectLiveProvider projectId={showProjectsStore && activeProjectId ? activeProjectId : null} currentUserId={user?.id ?? null}>
        <div className="flex h-full bg-[var(--bg-primary)] overflow-hidden">
            {/* Sidebar */}
            <Sidebar
                isOpen={sidebarOpen}
                isMobile={isMobile}
                onClose={() => setSidebarOpen(false)}
                toggleSidebar={() => setSidebarOpen(!sidebarOpen)}
                onNewChat={handleNewChat}
                selectedAgent={selectedAgent}
                onClearSelection={() => setSelectedAgent(null)}
                favorites={favorites}
                agents={agents}
                groupedConversations={getGroupedConversations()}
                currentConversation={currentConversation}
                onSelectConversation={onSelectConversation}
                onDeleteConversation={handleDeleteConversation}
                onSelectAgent={handleSelectAgent}
                onOpenMarketplace={() => { closeAllOverlays(); setShowMarketplace(true); }}
                onOpenSearch={() => { closeAllOverlays({ keepPage: true }); setShowSearch(true); }}
                hasPermission={hasPermission}
                user={user}
                onLogout={onLogout}
                onNavigate={(page: string) => { if (isMobile) setSidebarOpen(false); onNavigate(page); }}
                currentPage={currentPage}
                studioRoute={studioRoute}
                projectRail={projectRailActive && activeProjectId ? {
                    projectId: activeProjectId,
                    tab: initialProjectRoute?.tab ?? null,
                    onSelectTab: (tab: string|null|undefined) => goToProject(activeProjectId, tab),
                    onBack: () => goToProject(null),
                    onOpenProject: (id: string|null) => goToProject(id),
                    onOpenSearch: () => setProjectSearchOpen(true),
                    notebooksEnabled,
                } : null}
                showSettings={showSettings}
                showAgentDesigner={showAgentDesigner}
                showSkillsPanel={showSkillsPanel}
                showMarketplace={showMarketplace}
                onDirectChat={handleDirectChat}
                directChatMode={directChatMode}
                directConversations={directConversations}
                onSelectDirectConversation={onSelectDirectConversation}
                onDeleteDirectConversation={handleDeleteDirectConversation}
                currentDirectConversation={currentDirectConversation}
                onToggleFavorite={handleToggleFavorite}
                projects={projects}
                activeProject={activeProjectLive}
                onOpenProject={onOpenProject}
                onNewChatInProject={onNewChatInProject}
                onCreateProject={onCreateProject}
                onBrowseProjects={onBrowseProjects}
                onMoveToProject={handleMoveToProject}
                onShareToProject={handleShareToProject}
                onRenameConversation={handleRenameConversation}
                onPinConversation={handlePinConversation}
                onLabelConversation={handleLabelConversation}
                conversationLabels={conversationLabels}
                onCreateLabel={handleCreateLabel}
                onDeleteLabel={handleDeleteLabel}
                onEditLabel={handleEditLabel}
                chatHistoryMode={chatHistoryMode}
                allAgentConversations={allAgentConversations}
                onSelectAllChatsConversation={onSelectAllChatsConversation}
            />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 relative">
                <HubMainContent
                    {...{
                        showSettings, showStudio, showAgentDesigner, showAgentWizard, currentPage,
                        showSkillsPanel, showMarketplace, showProjectsStore,
                        user, t, isMobile, onNavigate, hasPermission,
                        onLogout, onUpdateUser, onCloseSettings, studioRoute, onCloseStudio, modelTiers, setStudioFullscreen,
                        initialDesignerAgentId, onCloseAgentDesigner, onCloseAgentWizard,
                        initialCoworkId, initialDocumentId, formViewToken, canUseWebpagesSide,
                        onCloseSkillsPanel, activeSkillIds, handleToggleSkill, agents, favorites, agentCategories,
                        handleToggleFavorite, handleSelectAgent, setShowMarketplace, handleUnpublishAgent,
                        activeProjectId, initialProjectRoute, projects, projectsQuery, projectsEnabled, goToProject, closeProjects,
                        queryClient, activeProject, setActiveProject, openProjectThread, startProjectChat, notebooksEnabled,
                        projectSearchOpen, setProjectSearchOpen,
                    }}
                    chat={{
                        selectedAgent, directChatMode, t, setActiveProject,
                        isMobile, setSidebarOpen, user, onNavigate, favorites, showAgentMenu, setShowAgentMenu,
                        handleNewChat, handleToggleFavorite, handleUnpublishAgent,
                        coworkMode, setCoworkMode, setCoworkModeForAgent, conversationStarted, notebooksEnabled, inCoworkMode,
                        sidePanelDocumentId, openDocumentInSidePanel, closeDocumentPanel,
                        canUseWebpagesSide, webpageButtonRef, webpageButtonRefDirect, sidePanelWebpageId, closeWebpagePanel,
                        webpagePickerOpen, setWebpagePickerOpen, openWebpageInSidePanel,
                        messagesContainerRef, messagesEndRef, shouldForceScrollRef, messages, chatInput, setChatInput,
                        sendMessage, stopGenerating, isLoading, activeSkillIds, agentAttachedSkillIds, handleToggleSkill,
                        handleVoiceTurnComplete, coworkComposer, currentConversation, retryMessage, editAndRegenerate,
                        modelTiers, selectedTier, setSelectedTier, renderSidePanels, activeProjectLive, openActiveProject, chatSignals,
                        directSessionSkills, directActivatedSessionSkillIds, directCompletedSessionSkillIds,
                        currentDirectConversation, directChatKbs, directChatKBIds, setDirectChatKBIds,
                        attachedWebpageSelection, clearWebpageSelection, setAttachedWebpageSelection,
                        onCloseSettings, onCloseAgentDesigner, setShowMarketplace,
                    }}
                />
            </div>

            {/* Global Search Overlay */}
            <SearchOverlay
                isOpen={showSearch}
                onClose={() => setShowSearch(false)}
                onSelectResult={handleSearchResultSelect}
                agents={agents}
            />

            {/* Memory Panel */}
            {
                showMemoryPanel && (
                    <MemoryPanel
                        agentId={selectedAgent?.id}
                        onClose={() => setShowMemoryPanel(false)}
                    />
                )
            }
            {confirmDialog}
        </div >
        </ProjectLiveProvider>
        </Suspense>
    );
};

export default AgentHub;
