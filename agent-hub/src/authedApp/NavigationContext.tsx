import React, { createContext, useContext, useMemo } from 'react';
import type { AppRoute } from './appRoutes';
import type { NavigateToPage } from './useNavigateToPage';

/**
 * Navigation for every component under the app shell: the call that moves to
 * a page (the same one the shell hands pages as `onNavigate`) and the route
 * the app is at. A component used outside the shell too (a test, an embed)
 * keeps its `onNavigate` prop and falls back to this when the prop is absent
 * (useOptionalNavigation).
 */
export interface Navigation {
    navigateToPage: NavigateToPage;
    route: AppRoute;
}

const NavigationContext = createContext<Navigation | null>(null);

export function NavigationProvider({ navigateToPage, route, children }: Navigation & { children: React.ReactNode }) {
    const value = useMemo(() => ({ navigateToPage, route }), [navigateToPage, route]);
    return <NavigationContext.Provider value={value}>{children}</NavigationContext.Provider>;
}

/** The navigation of the shell, or null outside it. */
export function useOptionalNavigation(): Navigation | null {
    return useContext(NavigationContext);
}
