import { useQueryClient } from '@tanstack/react-query';
import { Heart } from 'lucide-react';
import React, { useState, useEffect, useEffectEvent, useRef, useCallback, Suspense } from 'react';
import { v4 as uuidv4 } from 'uuid';
import AgentChatView from './AgentHub/AgentChatView';
import ChatSidePanels from './AgentHub/ChatSidePanels';
import DirectChatView from './AgentHub/DirectChatView';
import ProjectsView from './AgentHub/ProjectsView';
import useAgentHubActions from './AgentHub/useAgentHubActions';
import useAgentHubData from './AgentHub/useAgentHubData';
import useConversationMeta from './AgentHub/useConversationMeta';
import useDirectChatEvents from './AgentHub/useDirectChatEvents';
import useProjectChatStart from './AgentHub/useProjectChatStart';
import useSidePanelState from './AgentHub/useSidePanelState';
import { projectKeys, useProjectsQuery } from './api/queries/projects';
import beeFlowIcon from './assets/BeeFlow-logo-Icon-2026.svg';
import { describeSchedule } from './components/cowork/coworkSchedule';
import useCoworkComposer from './components/cowork/useCoworkComposer';
import { RequireTier, useLicenseContext } from './components/licensing/LicenseContext';
import { toast } from './components/shared/Toast';
import useConfirm from './components/shared/useConfirm';
import SearchOverlay from './components/shell/SearchOverlay';
import Sidebar from './components/shell/Sidebar';
import { useTranslation } from './hooks/useTranslation';
import { useViewport } from './hooks/useViewport';
import { lazy } from './utils/lazyWithReload';
import scopedStorage from './utils/scopedStorage';
import { rememberStudioItem } from './utils/studioRecents';
import { documentRefOf } from './pages/documents/notebookRef';

// ── Chat-critical (eager) ────────────────────────────────────────────
// These components are on the main chat path; deferring them costs more
// in flicker than they save in bundle size.

// ── Lazy: admin / studio / notebooks / marketplaces ──────────────────
// Each of these is opened from a modal slot or a separate route. Lazy
// loading saves ~1.2 MB off the initial bundle.
const AgentDesignerPanel = lazy(() => import('./components/agents/AgentDesignerPanel'));
const AgentMarketplace = lazy(() => import('./components/agents/AgentMarketplace'));
const MemoryPanel = lazy(() => import('./components/knowledge/memory/MemoryPanel'));
const AdvancedSettings = lazy(() => import('./pages/AdvancedSettings'));
const AgentStudio = lazy(() => import('./components/agents/AgentStudio/index'));
const Studio = lazy(() => import('./components/admin/Studio'));
const SkillsPanel = lazy(() => import('./components/skills/SkillsPanel'));
const CoworkPage = lazy(() => import('./components/cowork/CoworkPage'));
// The two published directories. They render in this inline slot rather than
// as standalone routes so the app sidebar stays put — arriving at either used
// to leave the user with no navigation but the Back button.
const AppsHomePage = lazy(() => import('./pages/apps/AppsHomePage'));
const FormsHomePage = lazy(() => import('./pages/forms/FormsHomePage'));
const DocumentsPage = lazy(() => import('./pages/documents/DocumentsPage'));
// One published form, shown inside the workspace at /app/forms/:token. The very
// same component serves it anonymously at /f/:token — being signed in does not
// change what the form is, only that the sidebar is still there around it.
const PublicFormPage = lazy(() => import('./pages/PublicFormPage'));

// Top-level pages rendered ABOVE the overlay branches in the main-content
// ternary. A page in this list hides any overlay opened while it is on screen,
// so closeAllOverlays() has to navigate away from it too. Keep it in sync with
// the branch order below — adding a page above the overlays without adding it
// here reintroduces BFSF-267 ("the sidebar item does nothing").
const PAGES_ABOVE_OVERLAYS = ['cowork', 'documents', 'apps', 'forms', 'formView'];

// One stable empty list, so a hub without projects does not hand the sidebar
// a new array on every render.
const NO_PROJECTS = [];

// Shared Suspense fallback — keeps lazy slots from flashing layout shifts.
// Each modal slot already renders inside its own animated container so a
// plain spinner is sufficient.
function LazyFallback() {
    return (
        <div className="flex items-center justify-center w-full h-full">
            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
        </div>
    );
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
}) => {
    // Share/collaboration copy is user-facing and Dutch-translated, so it goes
    // through the same dictionary as the rest of the UI rather than being
    // hardcoded here.
    const { t } = useTranslation();
    // Permission helper - checks if user has a specific permission
    const hasPermission = (perm) => {
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    };

    // Beta feature helper - checks if user's org has a beta feature enabled
    // Admins always have access to all beta features
    const hasBetaFeature = (featureId) => {
        if (user?.isAdmin || (user?.permissions || []).includes('all')) return true;
        const features = Array.isArray(user?.betaFeatures) ? user.betaFeatures : [];
        return features.includes(featureId);
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

    // ── Chat ⇄ Cowork ───────────────────────────────────────────────────
    // The composer can either talk to you (chat) or go do something (cowork).
    // One composer state for the whole hub, so flipping the switch in the
    // welcome composer and in the docked one is the same flip.
    const [coworkMode, setCoworkMode] = useState('chat');
    // In Cowork the composer produces a scheduled run, not a conversation, so
    // the chat-side panels have nothing to attach to: a Notebook and a Webpage
    // are things you read ALONGSIDE a conversation you are having.
    const inCoworkMode = coworkMode === 'cowork';
    const coworkComposer = useCoworkComposer({
        onCreated: (created) => {
            // Say what it understood, not just that it worked: the schedule was
            // read out of the user's own sentence, so it has to be visible and
            // correctable rather than silently assumed.
            const schedule = describeSchedule({
                presetId: 'custom',
                runAt: created?.nextRunAt,
                repeatInterval: created?.repeatInterval,
            });
            toast.success(`"${created?.title || 'Untitled cowork'}" scheduled — ${schedule}. Change it under Cowork in the sidebar.`);
        },
    });
    // Agent chat defaults the work to that agent: if you're mid-conversation
    // with an agent and delegate something, you mean that agent to do it.
    // Only seed an agent the picker actually offers — outside the
    // agent_routines beta the create call would 403 on the agentId.
    const coworkAgentIds = coworkComposer.agents;
    const setCoworkAgentId = coworkComposer.setAgentId;
    const setCoworkModeForAgent = useCallback((mode, agentId) => {
        setCoworkMode(mode);
        if (mode === 'cowork' && agentId && coworkAgentIds.some(a => a.id === agentId)) {
            setCoworkAgentId(agentId);
        }
    }, [coworkAgentIds, setCoworkAgentId]);

    // Notebook layout: split-pane sibling column at every breakpoint above
    // mobile. On compact (13" laptops) it takes a fixed ~420 px width so the
    // chat keeps usable room; on desktop it splits 50/50 with the chat. No
    // floating drawer or scrim — the notebook simply sits to the right of
    // the chat, the way users expect a split workspace.
    const notebookWrapperClass = isCompact
        ? "w-[420px] flex-shrink-0 flex flex-col h-full border-l border-[var(--border-subtle)] animate-in slide-in-from-right duration-300"
        : "w-1/2 min-w-[400px] flex flex-col h-full border-l border-[var(--border-subtle)] animate-in slide-in-from-right duration-300";

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
    const [agents, setAgents] = useState([]);
    const [agentCategories, setAgentCategories] = useState([]);
    const [selectedAgent, setSelectedAgent] = useState(null);
    const [conversations, setConversations] = useState([]);
    const [currentConversation, setCurrentConversation] = useState(null);
    // Sidebar defaults to its full-width state only on true desktops (>=1280).
    // Default to expanded on anything wider than a tablet; only small screens
    // start in icon-rail mode. The user can still toggle it.
    const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
    const [studioFullscreen, setStudioFullscreen] = useState(false);
    // Collapse the main sidebar to its icon-rail whenever Studio is open OR a
    // child explicitly asks for fullscreen (legacy path used by AgentStudio's
    // edit mode). Stash the prior expanded/collapsed state so we can restore
    // it when the user navigates back out of Studio.
    const collapseForStudio = showStudio || studioFullscreen;
    const sidebarOpenBeforeStudioRef = useRef(null);
    // An Effect Event: it snapshots `sidebarOpen` at the moment the flag flips,
    // and must not run again when the user toggles the sidebar inside Studio.
    const syncSidebarToStudio = useEffectEvent((collapse) => {
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
    useEffect(() => { syncSidebarToStudio(collapseForStudio); }, [collapseForStudio]);
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
        toggleNotebookPanel,
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
    const [modelTiers, setModelTiers] = useState({});
    const [directConversations, setDirectConversations] = useState([]);
    const [currentDirectConversation, setCurrentDirectConversation] = useState(null);
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
    const [activeProject, setActiveProject] = useState(null);
    const activeProjectLive = !activeProject ? null
        : projectsQuery.isSuccess ? (projects.find(p => p.id === activeProject.id) || null)
            : activeProject;
    const [showProjectsStore, setShowProjectsStore] = useState(false);
    // null = closed, '' = create-new, otherwise an existing project id
    const [activeProjectId, setActiveProjectId] = useState(null);

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
    const goToProject = useCallback((projectId, tab, sub) => {
        setShowProjectsStore(true);
        setActiveProjectId(projectId ?? null);
        if (onProjectRouteChange) onProjectRouteChange(projectId, tab, sub);
    }, [onProjectRouteChange]);

    const closeProjects = useCallback(() => {
        if (onCloseProjects) onCloseProjects();
        else { setShowProjectsStore(false); setActiveProjectId(null); }
    }, [onCloseProjects]);

    // Conversation Labels State
    const [conversationLabels, setConversationLabels] = useState([]);

    // Chat History Mode — "per-agent" (default) or "all-chats" (unified timeline).
    // Initial value is null because scopedStorage isn't populated until App.jsx's
    // setCurrentUser fires. The useEffect below hydrates on first render.
    const [chatHistoryMode, setChatHistoryMode] = useState('per-agent');
    const [allAgentConversations, setAllAgentConversations] = useState([]);

    // Skills State (must be declared before useChatEngine so it can reference activeSkillIds)
    const [activeSkillIds, setActiveSkillIds] = useState([]);
    const [directSessionSkills, setDirectSessionSkills] = useState([]);
    const [directActivatedSessionSkillIds, setDirectActivatedSessionSkillIds] = useState([]);
    // Knowledge bases attached to the current direct chat. Persisted on the
    // conversation since C3: the detail GET hands back the authorised list on
    // every load, and the composer writes changes through PATCH — so this is a
    // mirror of the server's column, not a session-local preference.
    const [directChatKBIds, setDirectChatKBIds] = useState([]);
    const [directCompletedSessionSkillIds, setDirectCompletedSessionSkillIds] = useState([]);

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
    // floating overlay first." Without this, opening a chat / notification /
    // marketplace while Studio (or AgentWizard / SkillsPanel / etc) is open
    // leaves the overlay sitting on top of the new content. Every navigation
    // entry point should call this before changing state.
    // `keepPage` is for callers that open something *on top of* the main
    // content (the search palette) rather than replacing it — those have no
    // reason to throw the user off the page they were on.
    const closeAllOverlays = ({ keepPage = false } = {}) => {
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

    // Navigation-level handlers (select agent/conversation, direct chat, new
    // chat, delete, search routing, favourites, unpublish, notebook save).
    // Plain closures, no hooks — moved verbatim; closeAllOverlays stays here
    // above (pinned by AgentHub.overlayOrder.test.js) and is passed in.
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

    // The project a workspace page is showing, for the chat context. The list
    // row is preferred; the page's own detail read covers a list that has not
    // arrived yet.
    const projectForContext = (projectId) => (projectId
        ? projects.find(p => p.id === projectId) || queryClient.getQueryData(projectKeys.detail(projectId)) || null
        : null);

    // Opening a shared thread leaves the project page and lands in the chat
    // itself, with the project as the chat context so its instructions and
    // knowledge apply to whatever the member replies.
    const openProjectThread = (thread) => {
        const agent = thread.type === 'agent' ? agents.find(a => a.id === thread.agentId) : null;
        if (thread.type === 'agent' && !agent) {
            toast.error(t('sidebar.project_thread_agent_unavailable', 'This chat belongs to an agent you cannot open.'));
            return;
        }
        const project = projectForContext(activeProjectId);
        if (project) setActiveProject(project);
        closeProjects();
        if (agent) {
            handleSelectAgent(agent);
            selectConversation(agent.id, thread.id);
            return;
        }
        if (!directChatMode || selectedAgent) {
            setDirectChatMode(true);
            setSelectedAgent(null);
            scopedStorage.setItem('lastUsedMode', 'direct-chat');
            loadModelTiers();
        }
        handleSelectDirectConversation({ id: thread.id });
    };

    // Pill in the chat header → back to the project's home.
    const openActiveProject = (project) => {
        closeAllOverlays();
        goToProject(project.id);
    };

    if (designMode) {
        return (
            <Suspense fallback={<LazyFallback />}>
                <AgentDesignerPanel
                    agent={selectedAgent}
                    user={user}
                    onClose={() => setDesignMode(false)}
                    onSave={(newAgent) => {
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
    const renderSidePanels = (mode) => (
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
                onSelectConversation={(conv) => {
                    closeAllOverlays();
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
                }}
                onDeleteConversation={handleDeleteConversation}
                onSelectAgent={handleSelectAgent}
                onOpenMarketplace={() => { closeAllOverlays(); setShowMarketplace(true); }}
                onOpenSearch={() => { closeAllOverlays({ keepPage: true }); setShowSearch(true); }}
                hasPermission={hasPermission}
                user={user}
                onLogout={onLogout}
                onNavigate={(page) => { if (isMobile) setSidebarOpen(false); onNavigate(page); }}
                currentPage={currentPage}
                studioRoute={studioRoute}
                showSettings={showSettings}
                showAgentDesigner={showAgentDesigner}
                showSkillsPanel={showSkillsPanel}
                showMarketplace={showMarketplace}
                onDirectChat={handleDirectChat}
                directChatMode={directChatMode}
                directConversations={directConversations}
                onSelectDirectConversation={(conv) => {
                    // Close every overlay before switching to direct chat —
                    // Studio, Agent Wizard, Notebooks, and Webpages were missing
                    // here, so picking a direct chat from history while Studio
                    // was open updated the URL but kept the editor on screen.
                    closeAllOverlays();
                    // Ensure we're in direct chat mode
                    if (!directChatMode) {
                        setDirectChatMode(true);
                        setSelectedAgent(null);
                        scopedStorage.setItem('lastUsedMode', 'direct-chat');
                        loadModelTiers();
                    }
                    handleSelectDirectConversation(conv);
                    if (isMobile) setSidebarOpen(false);
                }}
                onDeleteDirectConversation={handleDeleteDirectConversation}
                currentDirectConversation={currentDirectConversation}
                onToggleFavorite={handleToggleFavorite}
                projects={projects}
                activeProject={activeProjectLive}
                onOpenProject={(p) => {
                    // Opening a project also makes it the chat context: the
                    // chats started from here on belong to it.
                    closeAllOverlays();
                    setActiveProject(p);
                    goToProject(p.id);
                }}
                onNewChatInProject={(p) => {
                    setActiveProject(p);
                    closeProjects();
                    handleDirectChat();
                }}
                onCreateProject={() => {
                    // BFSF-267: these hand-rolled subset closes missed overlays
                    // (and Studio/AgentWizard/Notebooks) — route through the
                    // single source of truth, then navigate.
                    closeAllOverlays();
                    goToProject('');
                }}
                onBrowseProjects={() => {
                    // The list had no way in at all: it only rendered after the
                    // detail view was closed, and nothing opened it directly.
                    closeAllOverlays();
                    goToProject(null);
                }}
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
                onSelectAllChatsConversation={(conv) => {
                    // Close every overlay before switching context — Studio, Agent
                    // Wizard, Notebooks, Webpages, etc. were all missing here, which
                    // is why clicking a chat from history while Studio was open
                    // appeared to "do nothing": the conversation loaded behind the
                    // Studio overlay. closeAllOverlays() is the single source of
                    // truth for this and matches the per-agent path above.
                    closeAllOverlays();
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
                }}
            />

            {/* Main Content Area */}
            <div className="flex-1 flex flex-col min-w-0 relative">
                {showSettings ? (
                    /* Settings rendered inline in conversation area — Open WebUI style */
                    <AdvancedSettings onBack={null} onNavigate={onNavigate} onLogout={onLogout} user={user} onUpdateUser={onUpdateUser} onClose={onCloseSettings} />
                ) : showStudio ? (
                    /* Unified Studio: Agents / Skills / AI Tasks under one shell. */
                    <Studio
                        user={user}
                        section={studioRoute.section}
                        initialAgentId={studioRoute.section === 'agents' ? studioRoute.id : null}
                        initialSkillId={studioRoute.section === 'skills' ? studioRoute.id : null}
                        initialKbId={studioRoute.section === 'knowledge' ? studioRoute.id : null}
                        initialKbTab={studioRoute.section === 'knowledge' ? (studioRoute.sub || null) : null}
                        initialSourceId={studioRoute.section === 'knowledge' ? (studioRoute.subId || null) : null}
                        initialTaskId={studioRoute.section === 'aiTasks' && studioRoute.automationKind !== 'step' ? studioRoute.id : null}
                        initialStepId={studioRoute.section === 'aiTasks' && studioRoute.automationKind === 'step' ? studioRoute.id : null}
                        initialFlowletKey={studioRoute.section === 'aiTasks' ? (studioRoute.sub || null) : null}
                        initialWebpageId={studioRoute.section === 'webpages' ? studioRoute.id : null}
                        initialDocumentId={studioRoute.section === 'documents' ? documentRefOf(studioRoute) : null}
                        initialStudioAppId={studioRoute.section === 'apps' ? studioRoute.id : null}
                        // Meeting Notes accepts a deep link too, so the sidebar's
                        // "recently edited" rows can land on the transcript itself
                        // and not just on the section.
                        initialMeetingId={studioRoute.section === 'meetingNotes' ? studioRoute.id : null}
                        initialApprovalId={studioRoute.section === 'approvals' ? studioRoute.id : null}
                        initialSolutionId={studioRoute.section === 'solutions' ? studioRoute.id : null}
                        initialDatatableId={studioRoute.section === 'datatables' ? studioRoute.id : null}
                        initialDatatableTab={studioRoute.section === 'datatables' ? (studioRoute.sub || null) : null}
                        // A form is addressed by its AUTOMATION id (never the page
                        // token) — Studio → Forms → one form, with its tab.
                        initialFormId={studioRoute.section === 'forms' ? studioRoute.id : null}
                        initialFormTab={studioRoute.section === 'forms' ? (studioRoute.sub || null) : null}
                        initialPlaybookId={studioRoute.section === 'playbooks' ? studioRoute.id : null}
                        // Builder query state (?view/run/step) — a run deep-link.
                        // `?run=` is read for Runs & log as well: that section
                        // has no `/:id` path segment (a run is addressed by the
                        // same query string the builder uses), so without this
                        // a link to one run in the org's log would open the log
                        // and drop the run. `?view=` stays builder-only — the
                        // Runs section has no views to switch between.
                        initialBuilderView={studioRoute.section === 'aiTasks' ? (studioRoute.view || null) : null}
                        initialRunId={studioRoute.section === 'aiTasks' || studioRoute.section === 'runs' ? (studioRoute.runId || null) : null}
                        initialRunStepId={studioRoute.section === 'aiTasks' || studioRoute.section === 'runs' ? (studioRoute.stepId || null) : null}
                        // ?from=app:… — the button in an app this builder was
                        // opened from, for the breadcrumb back (P4). Builder
                        // only: no other section has a trail to draw.
                        initialFrom={studioRoute.section === 'aiTasks' ? (studioRoute.from || null) : null}
                        onClose={onCloseStudio}
                        onNavigate={onNavigate}
                        modelTiers={modelTiers}
                        onEditingChange={setStudioFullscreen}
                        hasPermission={(perm) => {
                            const perms = user?.permissions || [];
                            return perms.includes('all') || perms.includes(perm);
                        }}
                    />
                ) : showAgentDesigner ? (
                    /* Unified Agent Studio: list + wizard split layout. Replaces the
                       legacy AgentDesigner as the primary editor. The legacy form
                       (advanced settings: guardrails, embed, bubble widget, sharing)
                       is still reachable via "Advanced" inside the studio. */
                    /* Gate the whole editor on manage_agents — the server 403s on
                       /agents/all, so a user without the permission reaching here
                       (via the marketplace pencil or a direct URL) just saw a broken
                       load-error/retry loop (BFSF-181). Block the mount instead. */
                    ((user?.permissions || []).some(p => p === 'all' || p === 'manage_agents')) ? (
                    <AgentStudio
                        user={user}
                        initialAgentId={initialDesignerAgentId}
                        onClose={onCloseAgentDesigner}
                        onNavigate={onNavigate}
                        hasPermission={(perm) => {
                            const perms = user?.permissions || [];
                            return perms.includes('all') || perms.includes(perm);
                        }}
                    />
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                            <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('app.agent_hub_no_editor_access_title', 'No access to the Agent Editor')}</p>
                            <p className="text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>{t('app.agent_hub_no_editor_access_body', "You don't have permission to edit agents. Contact an administrator if you need access.")}</p>
                            <button onClick={() => onNavigate('agents')} className="px-3 py-1.5 rounded-md text-sm font-medium" style={{ background: 'var(--accent-primary)', color: 'white' }}>{t('agent_studio.header.back_to_agents', 'Back to Agents')}</button>
                        </div>
                    )
                ) : showAgentWizard ? (
                    /* /app/agent-wizard kept as a deep link — same studio, opens in
                       wizard (chat) mode for fresh creation. `startInWizard` is what
                       keeps that promise since the studio's idle state became the
                       card grid (A5); without it this link would land on the
                       overview and the deep link would silently mean something else. */
                    /* DEZELFDE POORT als de deur hierboven (BFSF-181). Hij
                       ontbrak hier, en sinds A5 heeft het overzicht een "Back
                       to Agents"-knop: een gebruiker zonder manage_agents kwam
                       daarmee schermvullend op een raster te staan waarvan
                       /agents/all 403't — alleen een foutbanner, geen enkele
                       actie. Geen datalek (de server weigert), wel precies de
                       kapotte staat die BFSF-181 aan de andere deur dichtzette. */
                    ((user?.permissions || []).some(p => p === 'all' || p === 'manage_agents')) ? (
                        <AgentStudio
                            user={user}
                            initialAgentId={null}
                            startInWizard
                            onClose={onCloseAgentWizard}
                            onNavigate={onNavigate}
                            hasPermission={(perm) => {
                                const perms = user?.permissions || [];
                                return perms.includes('all') || perms.includes(perm);
                            }}
                        />
                    ) : (
                        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
                            <p className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('app.agent_hub_no_editor_access_title', 'No access to the Agent Editor')}</p>
                            <p className="text-sm max-w-md" style={{ color: 'var(--text-muted)' }}>{t('app.agent_hub_no_editor_access_body', "You don't have permission to edit agents. Contact an administrator if you need access.")}</p>
                            <button onClick={() => onNavigate('agents')} className="px-3 py-1.5 rounded-md text-sm font-medium" style={{ background: 'var(--accent-primary)', color: 'white' }}>{t('agent_studio.header.back_to_agents', 'Back to Agents')}</button>
                        </div>
                    )
                ) : currentPage === 'cowork' ? (
                    /* Cowork (/app/cowork[/:id]) — the front door for prompt
                       automation and the only place it lives. Same inline slot
                       as Notebooks/Settings so the sidebar stays put. Driven
                       straight off currentPage: navigateToPage already clears
                       every overlay flag for a top-level page, so there's no
                       separate `showCowork` boolean to keep in sync. */
                    <CoworkPage user={user} isMobile={isMobile} initialCoworkId={initialCoworkId} onNavigate={onNavigate} />
                ) : currentPage === 'documents' ? (
                    <DocumentsPage
                        mode="workspace"
                        user={user}
                        initialDocumentId={initialDocumentId}
                        onDocumentChange={(id) => onNavigate(id ? `documents/${id}` : 'documents')}
                    />
                ) : currentPage === 'apps' ? (
                    /* Published-apps directory (/app/apps). Same inline slot as
                       Cowork, for the same reason: the sidebar stays. Tiles
                       link on to the standalone run view at /app/apps/:id,
                       which IS full-viewport. */
                    <AppsHomePage />
                ) : currentPage === 'forms' ? (
                    /* Published-forms directory (/app/forms). A tile opens the
                       form itself, in this tab, at /app/forms/:token. */
                    <FormsHomePage onNavigate={onNavigate} />
                ) : currentPage === 'formView' ? (
                    <div className="h-full overflow-y-auto custom-scrollbar px-4 py-8">
                        <div className="mx-auto w-full max-w-xl">
                            {/* This slot only ever renders inside the authenticated
                                workspace (App.jsx redirects /f/<token> here before
                                the page mounts), so `user` being set IS "signed in".
                                Gates the closing page's server-side result actions
                                (Word/PDF, Notebook, Webpage) — see the props' own
                                doc comment in PublicFormPage. */}
                            <PublicFormPage token={formViewToken} authenticated={!!user} webpagesEnabled={canUseWebpagesSide} />
                        </div>
                    </div>
                ) : showSkillsPanel ? (
                    /* Skills panel rendered inline in conversation area */
                    <SkillsPanel
                        user={user}
                        onClose={onCloseSkillsPanel}
                        activeSkillIds={activeSkillIds}
                        onToggleSkill={handleToggleSkill}
                        agents={agents}
                    />
                ) : showMarketplace ? (
                    /* Agent Marketplace rendered inline in conversation area */
                    <AgentMarketplace
                        agents={agents}
                        favorites={favorites}
                        categories={agentCategories}
                        onToggleFavorite={handleToggleFavorite}
                        onSelect={handleSelectAgent}
                        onClose={() => setShowMarketplace(false)}
                        onUnpublish={handleUnpublishAgent}
                        /* Only expose the edit affordance to users who can actually
                           manage agents — ownership alone used to reveal the pencil,
                           routing the user into a studio that 403s (BFSF-181).
                           Hidden on mobile entirely: phones are view/chat-only, the
                           agent editor route is blocked there. */
                        onEditAgent={(!isMobile && (user?.permissions || []).some(p => p === 'all' || p === 'manage_agents'))
                            ? (agent) => { setShowMarketplace(false); onNavigate(agent ? `agentDesigner:${agent.id}` : 'agentDesigner'); }
                            : undefined}
                        user={user}
                    />
                ) : showProjectsStore ? (
                    /* Projects — the list at /app/projects, one workspace at
                       /app/projects/:id[/:tab[/:sub]], the create form at
                       /app/projects/new. */
                    <ProjectsView
                        route={{
                            projectId: activeProjectId,
                            tab: initialProjectRoute?.projectId === activeProjectId ? (initialProjectRoute?.tab || null) : null,
                            sub: initialProjectRoute?.projectId === activeProjectId ? (initialProjectRoute?.sub || null) : null,
                        }}
                        projects={projects}
                        loading={projectsQuery.isPending && projectsEnabled}
                        error={projectsQuery.isError ? t('sidebar.projects_load_failed', 'Could not load your projects.') : null}
                        user={user}
                        onGoToProject={goToProject}
                        onClose={closeProjects}
                        onSaved={() => queryClient.invalidateQueries({ queryKey: ['projects', 'list'] })}
                        onDeleted={(id) => {
                            if (activeProject?.id === id) setActiveProject(null);
                            goToProject(null);
                        }}
                        onOpenThread={openProjectThread}
                        onNavigate={onNavigate}
                        onStartChat={startProjectChat}
                        notebooksEnabled={notebooksEnabled}
                    />
                ) : selectedAgent ? (
                    <AgentChatView
                        isMobile={isMobile}
                        setSidebarOpen={setSidebarOpen}
                        selectedAgent={selectedAgent}
                        user={user}
                        onNavigate={onNavigate}
                        favorites={favorites}
                        showAgentMenu={showAgentMenu}
                        setShowAgentMenu={setShowAgentMenu}
                        handleNewChat={handleNewChat}
                        handleToggleFavorite={handleToggleFavorite}
                        handleUnpublishAgent={handleUnpublishAgent}
                        coworkMode={coworkMode}
                        setCoworkModeForAgent={setCoworkModeForAgent}
                        conversationStarted={conversationStarted}
                        notebooksEnabled={notebooksEnabled}
                        inCoworkMode={inCoworkMode}
                        sidePanelDocumentId={sidePanelDocumentId}
                        openDocumentInSidePanel={openDocumentInSidePanel}
                        closeDocumentPanel={closeDocumentPanel}
                        canUseWebpagesSide={canUseWebpagesSide}
                        webpageButtonRef={webpageButtonRef}
                        sidePanelWebpageId={sidePanelWebpageId}
                        closeWebpagePanel={closeWebpagePanel}
                        webpagePickerOpen={webpagePickerOpen}
                        setWebpagePickerOpen={setWebpagePickerOpen}
                        openWebpageInSidePanel={openWebpageInSidePanel}
                        messagesContainerRef={messagesContainerRef}
                        messagesEndRef={messagesEndRef}
                        shouldForceScrollRef={shouldForceScrollRef}
                        messages={messages}
                        chatInput={chatInput}
                        setChatInput={setChatInput}
                        sendMessage={sendMessage}
                        stopGenerating={stopGenerating}
                        isLoading={isLoading}
                        activeSkillIds={activeSkillIds}
                        agentAttachedSkillIds={agentAttachedSkillIds}
                        handleToggleSkill={handleToggleSkill}
                        handleVoiceTurnComplete={handleVoiceTurnComplete}
                        coworkComposer={coworkComposer}
                        currentConversation={currentConversation}
                        retryMessage={retryMessage}
                        editAndRegenerate={editAndRegenerate}
                        modelTiers={modelTiers}
                        renderSidePanels={renderSidePanels}
                        activeProject={activeProjectLive}
                        onOpenActiveProject={openActiveProject}
                        onLeaveActiveProject={() => setActiveProject(null)}
                        chatSignals={chatSignals}
                    />
                ) : directChatMode ? (
                    /* Direct Chat Mode */
                    <DirectChatView
                        isMobile={isMobile}
                        setSidebarOpen={setSidebarOpen}
                        user={user}
                        notebooksEnabled={notebooksEnabled}
                        conversationStarted={conversationStarted}
                        coworkMode={coworkMode}
                        setCoworkMode={setCoworkMode}
                        inCoworkMode={inCoworkMode}
                        sidePanelDocumentId={sidePanelDocumentId}
                        openDocumentInSidePanel={openDocumentInSidePanel}
                        closeDocumentPanel={closeDocumentPanel}
                        canUseWebpagesSide={canUseWebpagesSide}
                        webpageButtonRefDirect={webpageButtonRefDirect}
                        sidePanelWebpageId={sidePanelWebpageId}
                        closeWebpagePanel={closeWebpagePanel}
                        webpagePickerOpen={webpagePickerOpen}
                        setWebpagePickerOpen={setWebpagePickerOpen}
                        openWebpageInSidePanel={openWebpageInSidePanel}
                        messagesContainerRef={messagesContainerRef}
                        messagesEndRef={messagesEndRef}
                        shouldForceScrollRef={shouldForceScrollRef}
                        messages={messages}
                        chatInput={chatInput}
                        setChatInput={setChatInput}
                        sendMessage={sendMessage}
                        stopGenerating={stopGenerating}
                        isLoading={isLoading}
                        modelTiers={modelTiers}
                        selectedTier={selectedTier}
                        setSelectedTier={setSelectedTier}
                        activeSkillIds={activeSkillIds}
                        handleToggleSkill={handleToggleSkill}
                        handleVoiceTurnComplete={handleVoiceTurnComplete}
                        coworkComposer={coworkComposer}
                        directSessionSkills={directSessionSkills}
                        directActivatedSessionSkillIds={directActivatedSessionSkillIds}
                        directCompletedSessionSkillIds={directCompletedSessionSkillIds}
                        currentDirectConversation={currentDirectConversation}
                        directChatKbs={directChatKbs}
                        directChatKBIds={directChatKBIds}
                        setDirectChatKBIds={setDirectChatKBIds}
                        attachedWebpageSelection={attachedWebpageSelection}
                        clearWebpageSelection={clearWebpageSelection}
                        setAttachedWebpageSelection={setAttachedWebpageSelection}
                        retryMessage={retryMessage}
                        editAndRegenerate={editAndRegenerate}
                        renderSidePanels={renderSidePanels}
                        activeProject={activeProjectLive}
                        onOpenActiveProject={openActiveProject}
                        onLeaveActiveProject={() => setActiveProject(null)}
                        chatSignals={chatSignals}
                    />
                ) : (
                    /* No Agent Selected - Empty State */
                    <div className="flex-1 flex flex-col items-center justify-center p-8">
                        <img src={beeFlowIcon} alt={t('app.agent_hub_logo_alt', 'Bee Flow')} className="w-24 h-24 rounded-2xl object-contain mb-6 shadow-xl" />
                        <h1 className="text-2xl font-bold text-[var(--text-primary)] mb-2">
                            {t('app.agent_hub_welcome_title', 'Welcome to Bee Flow')}
                        </h1>
                        <p className="text-[var(--text-secondary)] text-center max-w-md mb-8">
                            {t('app.agent_hub_welcome_body', 'Select an agent from the marketplace to start chatting, or create your own custom AI assistant.')}
                        </p>
                        <button
                            onClick={() => { if (onCloseSettings) onCloseSettings(); if (onCloseAgentDesigner) onCloseAgentDesigner(); setShowMarketplace(true); }}
                            className="flex items-center gap-2 px-6 py-3 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary-hover)] text-white rounded-xl font-medium shadow-lg transition-all hover:scale-105"
                        >
                            {t('app.agent_hub_browse_agents', 'Browse Agents')}
                        </button>
                    </div>
                )}
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
        </Suspense>
    );
};

export default AgentHub;
