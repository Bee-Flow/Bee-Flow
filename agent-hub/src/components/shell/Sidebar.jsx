import React, { Suspense, useState, useRef, useCallback } from 'react';
import FlyoutRow from './sidebar/FlyoutRow';
import MyAgentsSection from './sidebar/MyAgentsSection';
import NavRow from './sidebar/NavRow';
import ProjectsSection from './sidebar/ProjectsSection';
import RecentChats from './sidebar/RecentChats';
import { FavoriteAgentsRail, NewProjectRow, ScrolledAwayStrip, SidebarTopBar } from './sidebar/SidebarChrome';
import { conversationActions, sidebarConversations } from './sidebar/sidebarConversations';
import SidebarFooter from './sidebar/SidebarFooter';
import { buildCoreNav, buildSecondaryNav } from './sidebar/sidebarNav';
import { readExpanded, writeExpanded } from './sidebar/sidebarTokens';
import { useActiveCoworkCount } from './sidebar/useActiveCoworkCount';
import { useScrolledAwayNav } from './sidebar/useScrolledAwayNav';
import { useSidebarAccess } from './sidebar/useSidebarAccess';
import { useSidebarFlyouts } from './sidebar/useSidebarFlyouts';
import { usesProjectRail, usesStudioRail } from '../../authedApp/appRoutes';
import useOutsideDismiss from '../../hooks/useOutsideDismiss';
import { useStudioMenuHidden } from '../../hooks/useStudioChrome';
import { useTranslation } from '../../hooks/useTranslation';
import useViewport from '../../hooks/useViewport';
import { API_BASE } from '../../utils/helpers';
import { lazy } from '../../utils/lazyWithReload';
// The Studio rail replaces this sidebar on Studio pages. Main-chunk-safe by
// design — see the import discipline note in studioApps.jsx.
import { isStudioBuilder } from '../admin/Studio/studioNav';
import StudioRail from '../admin/Studio/StudioRail';
import { useTheme } from '../appearance/ThemeContext';

// Lazy, so the project rail's chunk stays out of the sidebar's bundle: it is
// only fetched when a project page opens.
const ProjectRail = lazy(() => import('../projects/workspace/ProjectRail'));

// The props that have a default; every other prop is passed through as given.
const DEFAULTS = {
    isMobile: false,
    favorites: [], agents: [],
    studioRoute: null,
    // { projectId, tab, onSelectTab, onBack, onOpenProject, onOpenSearch,
    // notebooksEnabled } on one project's pages, otherwise null.
    projectRail: null,
    hasPermission: null,
    directConversations: [],
    projects: [],
    conversationLabels: [],
    chatHistoryMode: 'per-agent',
    allAgentConversations: [],
    showSettings: false,
    showAgentDesigner: false,
    showSkillsPanel: false,
    showMarketplace: false,
};

function withDefaults(props) {
    const out = { ...props };
    for (const [k, v] of Object.entries(DEFAULTS)) if (out[k] === undefined) out[k] = v;
    return out;
}

/**
 * Everything the sidebar holds or reads before it renders: the open sections,
 * the profile menu, the flyouts, what this person may see, and the rows that
 * scrolled away.
 */
function useSidebarState(p) {
    const { t, locale } = useTranslation();
    // The project rail folds to 64 px below 1280 px; its footer must fold with it.
    const { isDesktop } = useViewport();
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    // An open automation can hide the Studio menu (see hooks/useStudioChrome).
    const studioMenuHidden = useStudioMenuHidden();
    useTheme();
    const access = useSidebarAccess({ user: p.user, isMobile: p.isMobile, currentPage: p.currentPage, hasPermissionProp: p.hasPermission });
    const [agentsOpen, setAgentsOpen] = useState(() => readExpanded('agents', true));
    const [projectsOpen, setProjectsOpen] = useState(() => readExpanded('projects', true));
    const profileRef = useRef(null);
    const scrollRef = useRef(null);
    const toggleAgents = useCallback(() => setAgentsOpen(v => { writeExpanded('agents', !v); return !v; }), []);
    const toggleProjects = useCallback(() => setProjectsOpen(v => { writeExpanded('projects', !v); return !v; }), []);

    // Studio + Apps flyout panels — state, grace timers and dismissal all live
    // in useSidebarFlyouts (called here so the state stays on Sidebar's fiber).
    const flyouts = useSidebarFlyouts(scrollRef);
    // Close profile menu on outside click
    useOutsideDismiss(profileRef, () => setShowProfileMenu(false), { enabled: showProfileMenu, escape: false, defer: false });
    const { hiddenSecondaryKeys, setSecondaryRef } = useScrolledAwayNav(p.isOpen, scrollRef);
    const activeCoworkCount = useActiveCoworkCount(p.currentPage);

    // The refs travel apart from the rest, which render reads freely.
    const s = {
        t, locale, isDesktop, showProfileMenu, setShowProfileMenu, studioMenuHidden, access,
        agentsOpen, toggleAgents, projectsOpen, toggleProjects, flyouts,
        hiddenSecondaryKeys, setSecondaryRef, activeCoworkCount,
        // Simple Mode strips the sidebar to: New Chat, Search, Agents, Chat
        // History. Phone-sized screens always run the simplified surface —
        // see AgentHub's `simpleMode` — regardless of the stored preference.
        simpleMode: !!p.user?.simpleMode || p.isMobile,
    };
    return { s, profileRef, scrollRef };
}

const Sidebar = (props) => {
    const p = withDefaults(props);
    const { s, profileRef, scrollRef } = useSidebarState(p);

    // On mobile, completely hide when closed (hamburger in header opens it)
    if (!p.isOpen && p.isMobile) return null;

    const rail = sidebarRail(p, s, profileRef);
    if (rail !== undefined) return rail;

    const content = <SidebarPanel p={p} s={s} profileRef={profileRef} scrollRef={scrollRef} />;
    if (p.isMobile && p.isOpen) {
        return (
            <div className="fixed inset-0 z-50 flex">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => p.onClose?.()} />
                <div className="relative sidebar-slide-in" style={{ zIndex: 1 }}>{content}</div>
            </div>
        );
    }
    return content;
};

function accountFooter(p, s, isOpen, profileRef) {
    return (
        <SidebarFooter
            isOpen={isOpen}
            isMobile={p.isMobile}
            user={p.user}
            t={s.t}
            profileRef={profileRef}
            showProfileMenu={s.showProfileMenu}
            setShowProfileMenu={s.setShowProfileMenu}
            _simpleMode={s.simpleMode}
            currentPage={p.currentPage}
            showSettings={p.showSettings}
            onNavigate={p.onNavigate}
            onLogout={p.onLogout}
        />
    );
}

/**
 * The rail that replaces this sidebar, or undefined when none does (null: the
 * Studio rail is hidden by an open automation).
 *
 * The Studio rail (H1): on /app/studio* the workspace swaps THIS sidebar for
 * Studio's own 240px rail. The swap happens here rather than in AuthedApp
 * because AuthedApp does not render a Sidebar at all (AgentHub does), and
 * because whether we are below the mobile breakpoint is a fact only this
 * component holds. Three conditions, each load-bearing:
 *   usesStudioRail(page, section) — the page IS Studio, and it is not the
 *     Approvals slice (a Studio address with a member audience).
 *   !isMobile — a phone keeps the ordinary sidebar (canSeeStudio is false
 *     there anyway).
 *   canSeeStudio — someone who never had a Studio row does not get a Studio
 *     rail either; a deep link to a section they may open still renders it,
 *     with the sidebar they know beside it.
 *
 * The project rail: on /app/projects/:id* the same swap, for the project's
 * own rail — the page is one project, not a phone, and the hub handed over
 * the rail's route callbacks. The account footer is this sidebar's.
 */
function sidebarRail(p, s, profileRef) {
    const { access } = s;
    if (usesStudioRail(p.currentPage, p.studioRoute?.section) && !p.isMobile && access.canSeeStudio) {
        if (s.studioMenuHidden) return null;
        return (
            <StudioRail
                sections={access.studioSections}
                studioCounts={access.data.studioCounts}
                activeSection={p.studioRoute?.section || null}
                onNavigate={p.onNavigate}
                user={p.user}
                onLogout={p.onLogout}
                currentPage={p.currentPage}
                showSettings={p.showSettings}
                isMobile={p.isMobile}
                simpleMode={s.simpleMode}
                profileRef={profileRef}
                showProfileMenu={s.showProfileMenu}
                setShowProfileMenu={s.setShowProfileMenu}
                // The rail replaces this sidebar, and the top-level Approvals
                // row is the only entrance to that queue. It is not a Studio
                // section (hiddenFromNav), so it goes over as its own pair.
                canBrowseApprovals={access.canBrowseApprovals}
                pendingApprovalCount={access.pendingApprovalCount}
                // Start is a builder's dashboard; someone who has Studio for a
                // section or two gets just those.
                showStart={isStudioBuilder(p.user)}
            />
        );
    }
    const rail = p.projectRail;
    if (usesProjectRail(p.currentPage, rail?.projectId) && !p.isMobile && rail) {
        return (
            <Suspense fallback={<div className="w-60 flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)]" />}>
                <ProjectRail
                    projectId={rail.projectId}
                    activeTab={rail.tab}
                    onSelectTab={rail.onSelectTab}
                    onBack={rail.onBack}
                    onOpenProject={rail.onOpenProject}
                    onOpenSearch={rail.onOpenSearch}
                    projects={p.projects}
                    currentUserId={p.user?.id}
                    notebooksEnabled={rail.notebooksEnabled}
                    footer={accountFooter(p, s, s.isDesktop, profileRef)}
                />
            </Suspense>
        );
    }
    return undefined;
}

/** The nav rows, as data (sidebar/sidebarNav.tsx). */
// "New Chat" highlight must clear once any other destination takes over the
// main content, or two items look active at once (BFSF-172).
function otherViewActive(p) {
    return p.showMarketplace || p.showSettings
        || p.showSkillsPanel
        || ['studio', 'admin', 'cowork', 'documents', 'apps', 'appRun', 'forms', 'formView'].includes(p.currentPage);
}

/**
 * The lists behind the Studio, Apps and Forms rows, or null where the row is
 * not shown. `studioSections.length` is part of the gate: a builder permission
 * says this person may BUILD, the sections say there is something to build
 * with. Apps and Forms are listed only once something is published: a
 * directory of nothing is a dead end.
 */
function secondaryLists(p, access) {
    const { data } = access;
    return {
        studioSections: access.canSeeStudio && access.studioSections.length > 0 ? access.studioSections : null,
        publishedApps: access.canUseCapability('app_studio') && access.hasPermission('use_apps') && data.hasApps ? data.publishedApps : null,
        publishedForms: data.canSeeForms && access.hasPermission('use_forms') && data.hasForms && !p.isMobile ? data.publishedForms : null,
    };
}

function sidebarNav(p, s) {
    const { access, t } = s;
    const coreNav = buildCoreNav({
        t, onDirectChat: p.onDirectChat, newChatActive: p.directChatMode && !p.selectedAgent && !otherViewActive(p),
        onNavigate: p.onNavigate, currentPage: p.currentPage, studioSection: p.studioRoute?.section,
        activeCoworkCount: s.activeCoworkCount, showApprovals: access.canBrowseApprovals && access.hasApprovals,
        pendingApprovalCount: access.pendingApprovalCount, onOpenSearch: p.onOpenSearch, isMobile: p.isMobile,
    });
    const secondaryNav = buildSecondaryNav({
        t, locale: s.locale, studioCounts: access.data.studioCounts, onNavigate: p.onNavigate, currentPage: p.currentPage,
        studioSection: p.studioRoute?.section, onOpenMarketplace: p.onOpenMarketplace, showMarketplace: p.showMarketplace,
        user: p.user,
        ...secondaryLists(p, access),
    });
    return { coreNav, secondaryNav };
}

/**
 * Flyout-panel and nav rows render in sidebar/FlyoutRow and sidebar/NavRow;
 * these adapters thread Sidebar's state through as props (renderFlyoutRow is
 * also handed to NavRow for its panel).
 */
function rowRenderers(p, s) {
    const { flyouts, access, t, locale } = s;
    const renderFlyoutRow = (item) => (
        <FlyoutRow
            key={item.key}
            item={item}
            recentItemsFor={access.data.recentItemsFor}
            subFlyout={flyouts.subFlyout}
            closeFlyout={flyouts.closeFlyout}
            loadSectionItems={access.data.loadSectionItems}
            hoverSubFlyout={flyouts.hoverSubFlyout}
            scheduleSubFlyoutClose={flyouts.scheduleSubFlyoutClose}
            onNavigate={p.onNavigate}
            t={t}
            locale={locale}
        />
    );
    const renderNavRow = (item) => (
        <NavRow
            key={item.key}
            item={item}
            isOpen={p.isOpen}
            isMobile={p.isMobile}
            flyout={flyouts.flyout}
            openFlyout={flyouts.openFlyout}
            hoverFlyout={flyouts.hoverFlyout}
            closeFlyout={flyouts.closeFlyout}
            scheduleFlyoutClose={flyouts.scheduleFlyoutClose}
            renderFlyoutRow={renderFlyoutRow}
        />
    );
    return renderNavRow;
}

/** White-label override: the org's uploaded logo, in self-hosted deploys only. */
function orgBrandOf(user, deploymentMode) {
    const logo = user?.organization?.logo;
    const logoUrl = logo ? (logo.startsWith('/') ? `${API_BASE}${logo}` : logo) : null;
    if (deploymentMode !== 'self-hosted' || !logoUrl) return null;
    return { logoUrl, altText: user?.organization?.name || 'Organization' };
}

/** The sidebar itself: logo bar, pinned nav, the scrolling middle and the account footer. */
function SidebarPanel({ p, s, profileRef, scrollRef }) {
    const { t, setSecondaryRef } = s;
    const { isOpen } = p;
    const { coreNav, secondaryNav } = sidebarNav(p, s);
    const renderNavRow = rowRenderers(p, s);
    const favoriteAgents = p.agents.filter(a => p.favorites.includes(a.id));
    return (
        <div
            className={`h-full flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] flex-shrink-0 transition-all duration-300 ${isOpen ? 'w-72' : 'w-16 cursor-pointer'}`}
            data-testid="sidebar"
            data-surface="subtle"
            data-static
            onClick={(e) => {
                if (!isOpen && !e.target.closest('button')) {
                    p.toggleSidebar();
                }
            }}
        >
            <SidebarTopBar t={t} isOpen={isOpen} brand={orgBrandOf(p.user, s.access.deploymentMode)} onDirectChat={p.onDirectChat} toggleSidebar={p.toggleSidebar} />

            {/* ── Nav rows ── (pinned: New Chat + Search) */}
            <nav aria-label={t('sidebar.main_navigation', 'Main navigation')} data-testid="main-navigation" className={`px-2 pt-3 flex-shrink-0 flex flex-col gap-1 ${isOpen ? '' : 'items-center'}`}>
                {coreNav.map(renderNavRow)}
            </nav>

            {!isOpen && favoriteAgents.length > 0 && (
                <FavoriteAgentsRail agents={favoriteAgents} selectedAgentId={p.selectedAgent?.id} onSelectAgent={p.onSelectAgent} />
            )}

            {isOpen && s.hiddenSecondaryKeys.size > 0 && (
                <ScrolledAwayStrip items={secondaryNav.filter(item => s.hiddenSecondaryKeys.has(item.key))} />
            )}

            {/* ── Scrollable middle region (Secondary nav + Projects + My Agents + Chats) ── */}
            <div ref={scrollRef} className="flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar">
                {/* Secondary nav — inside the scroll region so it scrolls away like ChatGPT */}
                {isOpen && secondaryNav.length > 0 && (
                    <nav aria-label={t('sidebar.secondary_navigation', 'Secondary navigation')} className="px-2 pt-1 flex-shrink-0 flex flex-col gap-1">
                        {secondaryNav.map(item => (
                            <div key={item.key} ref={setSecondaryRef(item.key)} data-nav-key={item.key}>
                                {renderNavRow(item)}
                            </div>
                        ))}
                    </nav>
                )}
                <SidebarLists p={p} s={s} favoriteAgents={favoriteAgents} />
            </div>

            {accountFooter(p, s, isOpen, profileRef)}

            <style>{`
                @keyframes sidebarMenuIn {
                    from { opacity: 0; transform: translateY(4px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
}

/** Projects, My Agents and the recent chats, in the scrolling middle. */
function SidebarLists({ p, s, favoriteAgents }) {
    const { t } = s;
    const { isOpen } = p;
    const showProjects = isOpen && !s.simpleMode && s.access.hasLicenseFeature('projects') && p.user?.featureFlags?.projects !== false;
    const showMyAgents = isOpen && favoriteAgents.length > 0;
    return (
        <>
            {showProjects && p.projects.length > 0 && (
                <ProjectsSection
                    t={t}
                    projects={p.projects}
                    projectsOpen={s.projectsOpen}
                    toggleProjects={s.toggleProjects}
                    activeProject={p.activeProject}
                    onCreateProject={p.onCreateProject}
                    onOpenProject={p.onOpenProject}
                    onNewChatInProject={p.onNewChatInProject}
                    onBrowseProjects={p.onBrowseProjects}
                />
            )}
            {showProjects && p.projects.length === 0 && (
                <NewProjectRow t={t} onCreateProject={p.onCreateProject} />
            )}

            {/* ── My Agents ── (only when there are favorites, with a divider above) */}
            {showMyAgents && (
                <div className="mx-3 my-1.5 border-t border-[var(--border-subtle)]" />
            )}
            {showMyAgents && (
                <MyAgentsSection
                    t={t}
                    favoriteAgents={favoriteAgents}
                    agentsOpen={s.agentsOpen}
                    toggleAgents={s.toggleAgents}
                    selectedAgent={p.selectedAgent}
                    onSelectAgent={p.onSelectAgent}
                    onToggleFavorite={p.onToggleFavorite}
                />
            )}

            <RecentChats
                t={t}
                isOpen={isOpen}
                convs={sidebarConversations(p)}
                hasChatTarget={!!(p.selectedAgent || p.directChatMode)}
                actions={conversationActions(p)}
                agents={p.agents}
                rowHandlers={{
                    conversationLabels: p.conversationLabels, projects: p.projects, activeProjectId: p.activeProject?.id,
                    onRenameConversation: p.onRenameConversation, onPinConversation: p.onPinConversation,
                    onLabelConversation: p.onLabelConversation, onDeleteLabel: p.onDeleteLabel, onEditLabel: p.onEditLabel,
                    onCreateLabel: p.onCreateLabel, onMoveToProject: p.onMoveToProject, onShareToProject: p.onShareToProject,
                }}
            />
        </>
    );
}

export default Sidebar;
