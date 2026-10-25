import React, { Suspense } from 'react';
import FlyoutRow from './sidebar/FlyoutRow';
import NavRow from './sidebar/NavRow';
import SidebarFooter from './sidebar/SidebarFooter';
import { buildCoreNav, buildSecondaryNav, type NavItem, type NavRowItem } from './sidebar/sidebarNav';
import { usesProjectRail, usesStudioRail } from '../../authedApp/appRoutes';
import { API_BASE } from '../../utils/helpers';
import { lazy } from '../../utils/lazyWithReload';
import { isStudioBuilder } from '../admin/Studio/studioNav';
import StudioRail from '../admin/Studio/StudioRail';
import type { SidebarUser, ResolvedSidebarProps } from './Sidebar.types';
import { type SidebarState } from './Sidebar.types2';

// Lazy, so the project rail's chunk stays out of the sidebar's bundle: it is
// only fetched when a project page opens.
const ProjectRail = lazy(() => import('../projects/workspace/ProjectRail'));

export function accountFooter(p: ResolvedSidebarProps, s: SidebarState, isOpen: boolean, profileRef: React.RefObject<HTMLDivElement | null>) {
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
export function sidebarRail(p: ResolvedSidebarProps, s: SidebarState, profileRef: React.RefObject<HTMLDivElement | null>) {
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
function otherViewActive(p: ResolvedSidebarProps) {
    return p.showMarketplace || p.showSettings
        || p.showSkillsPanel
        || ['studio', 'admin', 'cowork', 'documents', 'apps', 'appRun', 'forms', 'formView'].includes(p.currentPage as string);
}

/**
 * The lists behind the Studio, Apps and Forms rows, or null where the row is
 * not shown. `studioSections.length` is part of the gate: a builder permission
 * says this person may BUILD, the sections say there is something to build
 * with. Apps and Forms are listed only once something is published: a
 * directory of nothing is a dead end.
 */
function secondaryLists(p: ResolvedSidebarProps, access: SidebarState['access']) {
    const { data } = access;
    return {
        studioSections: access.canSeeStudio && access.studioSections.length > 0 ? access.studioSections : null,
        publishedApps: access.canUseCapability('app_studio') && access.hasPermission('use_apps') && data.hasApps ? data.publishedApps : null,
        publishedForms: data.canSeeForms && access.hasPermission('use_forms') && data.hasForms && !p.isMobile ? data.publishedForms : null,
    };
}

export function sidebarNav(p: ResolvedSidebarProps, s: SidebarState) {
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
export function rowRenderers(p: ResolvedSidebarProps, s: SidebarState) {
    const { flyouts, access, t, locale } = s;
    const renderFlyoutRow = (item: NavItem) => (
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
    const renderNavRow = (item: NavRowItem) => (
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
export function orgBrandOf(user: SidebarUser | null | undefined, deploymentMode: string | undefined) {
    const logo = user?.organization?.logo;
    const logoUrl = logo ? (logo.startsWith('/') ? `${API_BASE}${logo}` : logo) : null;
    if (deploymentMode !== 'self-hosted' || !logoUrl) return null;
    return { logoUrl, altText: user?.organization?.name || 'Organization' };
}
