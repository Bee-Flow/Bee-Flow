import type { QueryClient } from '@tanstack/react-query';
import React from 'react';
import type { AppUserLike } from '../components/projects/workspace/types';
import { renderHubChat, type HubChatContentProps } from './HubChatContent';
import {
    AdvancedSettings, AgentMarketplace, AgentStudio, AppsHomePage, CoworkPage, DocumentsPage,
    FormsHomePage, PublicFormPage, SkillsPanel, Studio,
} from './hubLazySlots';
import type { MarketCategory } from '../components/agents/AgentMarketplace.types';
import type { Project } from '../api/queries/projects';
import ProjectsView, { type ProjectsRoute } from './ProjectsView';
import { studioRouteProps, type StudioRoute } from './studioRouteProps';

type Translate = (key: string, fallback?: string) => string;
type Fn = (...args: any[]) => any;
type User = (AppUserLike & { permissions?: string[] | null; [key: string]: any }) | null;

/** What AgentHub's main column is fed. Most of it is passed straight through
 *  to the slot that renders; AgentHub owns all of the state. */
export interface HubMainContentProps {
    // Which slot wins (top to bottom, see the ternary below).
    showSettings: boolean;
    showStudio: boolean;
    showAgentDesigner: boolean;
    showAgentWizard: boolean;
    currentPage: string;
    showSkillsPanel: boolean;
    showMarketplace: boolean;
    showProjectsStore: boolean;
    // Shared.
    user: User;
    t: Translate;
    isMobile: boolean;
    onNavigate: (page: string) => void;
    hasPermission: (perm: string) => boolean;
    // Settings / Studio / agent editor.
    onLogout?: Fn;
    onUpdateUser?: Fn;
    onCloseSettings?: Fn;
    studioRoute: StudioRoute;
    onCloseStudio?: Fn;
    modelTiers: Record<string, unknown>;
    setStudioFullscreen: (on: boolean) => void;
    initialDesignerAgentId: string | null;
    onCloseAgentDesigner?: Fn;
    onCloseAgentWizard?: Fn;
    // Top-level pages.
    initialCoworkId: string | null;
    initialDocumentId: string | null;
    formViewToken: string | null;
    canUseWebpagesSide: boolean;
    // Skills panel / marketplace.
    onCloseSkillsPanel?: Fn;
    activeSkillIds: string[];
    handleToggleSkill: Fn;
    agents: any[];
    favorites: string[];
    agentCategories: MarketCategory[];
    handleToggleFavorite: Fn;
    handleSelectAgent: Fn;
    setShowMarketplace: (open: boolean) => void;
    handleUnpublishAgent: Fn;
    // Projects.
    activeProjectId: string | null;
    initialProjectRoute: (ProjectsRoute & { projectId?: string | null }) | null;
    projects: Project[];
    projectsQuery: { isPending: boolean; isError: boolean };
    projectsEnabled: boolean;
    goToProject: Fn;
    closeProjects: () => void;
    queryClient: QueryClient;
    activeProject: { id: string } | null;
    setActiveProject: Fn;
    openProjectThread: Fn;
    startProjectChat: Fn;
    notebooksEnabled: boolean;
    projectSearchOpen: boolean;
    setProjectSearchOpen: (open: boolean) => void;
    /** Everything the chat slot (agent chat, direct chat, welcome) needs. */
    chat: HubChatContentProps;
}

// Plain render functions rather than components: the element tree stays the
// one AgentHub rendered inline (each slot directly in the main column), so
// nothing remounts that did not before.

const canManageAgentsOf = (user: User) => (user?.permissions || []).some((p: string) => p === 'all' || p === 'manage_agents');

/** Shown in place of the agent editor to someone without manage_agents. */
function noEditorAccess({ t, onNavigate }: HubMainContentProps) {
    return (
        <div className="flex flex-col items-center justify-center h-full gap-3 p-8 text-center">
            <p className="text-base font-semibold text-[var(--text-primary)]">{t('app.agent_hub_no_editor_access_title', 'No access to the Agent Editor')}</p>
            <p className="text-sm max-w-md text-[var(--text-muted)]">{t('app.agent_hub_no_editor_access_body', "You don't have permission to edit agents. Contact an administrator if you need access.")}</p>
            <button onClick={() => onNavigate('agents')} className="px-3 py-1.5 rounded-md text-sm font-medium [background:var(--accent-primary)] [color:white]!">{t('agent_studio.header.back_to_agents', 'Back to Agents')}</button>
        </div>
    );
}

function studioSlot({ user, studioRoute, onCloseStudio, onNavigate, modelTiers, setStudioFullscreen, hasPermission }: HubMainContentProps) {
    return (
        /* Unified Studio: Agents / Skills / AI Tasks under one shell. */
        <Studio
            user={user}
            section={studioRoute.section}
            {...studioRouteProps(studioRoute)}
            onClose={onCloseStudio}
            onNavigate={onNavigate}
            modelTiers={modelTiers}
            onEditingChange={setStudioFullscreen}
            hasPermission={hasPermission}
        />
    );
}

function agentDesignerSlot(props: HubMainContentProps) {
    const { user, initialDesignerAgentId, onCloseAgentDesigner, onNavigate, hasPermission } = props;
    /* Unified Agent Studio: list + wizard split layout. Replaces the
       legacy AgentDesigner as the primary editor. The legacy form
       (advanced settings: guardrails, embed, bubble widget, sharing)
       is still reachable via "Advanced" inside the studio. */
    /* Gate the whole editor on manage_agents — the server 403s on
       /agents/all, so a user without the permission reaching here
       (via the marketplace pencil or a direct URL) just saw a broken
       load-error/retry loop (BFSF-181). Block the mount instead. */
    return canManageAgentsOf(user) ? (
        <AgentStudio
            user={user}
            initialAgentId={initialDesignerAgentId}
            onClose={onCloseAgentDesigner}
            onNavigate={onNavigate}
            hasPermission={hasPermission}
        />
    ) : noEditorAccess(props);
}

function agentWizardSlot(props: HubMainContentProps) {
    const { user, onCloseAgentWizard, onNavigate, hasPermission } = props;
    /* /app/agent-wizard kept as a deep link — same studio, opens in
       wizard (chat) mode for fresh creation. `startInWizard` is what
       keeps that promise since the studio's idle state became the
       card grid (A5); without it this link would land on the
       overview and the deep link would silently mean something else. */
    /* SAME GATE as the door above (BFSF-181). It was missing here, and since A5 the overview has a "Back
       to Agents" button: a user without manage_agents landed full-screen on a grid whose /agents/all
       returns 403 — only an error banner, no action at all. Not a data leak (the server refuses), but
       precisely the broken state that BFSF-181 closed at the other door. */
    return canManageAgentsOf(user) ? (
        <AgentStudio
            user={user}
            initialAgentId={null}
            startInWizard
            onClose={onCloseAgentWizard}
            onNavigate={onNavigate}
            hasPermission={hasPermission}
        />
    ) : noEditorAccess(props);
}

function marketplaceSlot(props: HubMainContentProps) {
    const {
        agents, favorites, agentCategories, handleToggleFavorite, handleSelectAgent, setShowMarketplace,
        handleUnpublishAgent, isMobile, user, onNavigate,
    } = props;
    return (
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
            onEditAgent={(!isMobile && canManageAgentsOf(user))
                ? (agent?: { id: string } | null) => { setShowMarketplace(false); onNavigate(agent ? `agentDesigner:${agent.id}` : 'agentDesigner'); }
                : undefined}
            user={user}
        />
    );
}

function projectsSlot(props: HubMainContentProps) {
    const {
        activeProjectId, initialProjectRoute, projects, projectsQuery, projectsEnabled, t, user, goToProject,
        closeProjects, queryClient, activeProject, setActiveProject, openProjectThread, onNavigate,
        startProjectChat, notebooksEnabled, projectSearchOpen, setProjectSearchOpen,
    } = props;
    return (
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
            onDeleted={(id: string) => {
                if (activeProject?.id === id) setActiveProject(null);
                goToProject(null);
            }}
            onOpenThread={openProjectThread}
            onNavigate={onNavigate}
            onStartChat={startProjectChat}
            notebooksEnabled={notebooksEnabled}
            searchOpen={projectSearchOpen}
            onSearchOpenChange={setProjectSearchOpen}
        />
    );
}

/**
 * AgentHub's main column: ONE slot, picked by a single ternary whose order is
 * behaviour. Settings outranks Studio, Studio the agent editor, and so on;
 * the `currentPage` branches sit ABOVE the overlay branches, which is why
 * they are listed in PAGES_ABOVE_OVERLAYS (hubOverlays.ts, BFSF-267, pinned
 * by AgentHub.overlayOrder.test.js).
 */
export default function HubMainContent(props: HubMainContentProps) {
    const {
        showSettings, showStudio, showAgentDesigner, showAgentWizard, currentPage,
        showSkillsPanel, showMarketplace, showProjectsStore,
        user, isMobile, onNavigate, onLogout, onUpdateUser, onCloseSettings,
        initialCoworkId, initialDocumentId, formViewToken, canUseWebpagesSide,
        onCloseSkillsPanel, activeSkillIds, handleToggleSkill, agents, chat,
    } = props;
    return showSettings ? (
        /* Settings rendered inline in conversation area — Open WebUI style */
        <AdvancedSettings onBack={null} onNavigate={onNavigate} onLogout={onLogout} user={user} onUpdateUser={onUpdateUser} onClose={onCloseSettings} />
    ) : showStudio ? (
        studioSlot(props)
    ) : showAgentDesigner ? (
        agentDesignerSlot(props)
    ) : showAgentWizard ? (
        agentWizardSlot(props)
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
            onDocumentChange={(id: string | null) => onNavigate(id ? `documents/${id}` : 'documents')}
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
        marketplaceSlot(props)
    ) : showProjectsStore ? (
        projectsSlot(props)
    ) : (
        renderHubChat(chat)
    );
}
