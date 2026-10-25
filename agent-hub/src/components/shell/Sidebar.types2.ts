import React, { useState, useRef, useCallback } from 'react';
import { type SidebarAgent } from './sidebar/sidebarConversations';
import { readExpanded, writeExpanded } from './sidebar/sidebarTokens';
import { useActiveCoworkCount } from './sidebar/useActiveCoworkCount';
import { useScrolledAwayNav } from './sidebar/useScrolledAwayNav';
import { useSidebarAccess } from './sidebar/useSidebarAccess';
import { useSidebarFlyouts } from './sidebar/useSidebarFlyouts';
import useOutsideDismiss from '../../hooks/useOutsideDismiss';
import { useStudioMenuHidden } from '../../hooks/useStudioChrome';
import { useTranslation } from '../../hooks/useTranslation';
import useViewport from '../../hooks/useViewport';
import { useTheme } from '../appearance/ThemeContext';
import type { ResolvedSidebarProps } from './Sidebar.types';

/**
 * Everything the sidebar holds or reads before it renders: the open sections,
 * the profile menu, the flyouts, what this person may see, and the rows that
 * scrolled away.
 */
export function useSidebarState(p: ResolvedSidebarProps) {
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
    const profileRef = useRef<HTMLDivElement>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
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

export type SidebarState = ReturnType<typeof useSidebarState>['s'];

/** The sidebar itself: logo bar, pinned nav, the scrolling middle and the account footer. */
export interface SidebarPanelProps {
    p: ResolvedSidebarProps;
    s: SidebarState;
    profileRef: React.RefObject<HTMLDivElement | null>;
    scrollRef: React.RefObject<HTMLDivElement | null>;
}

/** Projects, My Agents and the recent chats, in the scrolling middle. */
export interface SidebarListsProps {
    p: ResolvedSidebarProps;
    s: SidebarState;
    favoriteAgents: SidebarAgent[];
}
