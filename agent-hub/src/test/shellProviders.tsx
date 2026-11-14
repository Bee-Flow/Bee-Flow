import React from 'react';
import { NavigationProvider } from '@/authedApp/NavigationContext';
import { SessionProvider } from '@/authedApp/SessionContext';
import { matchAppRoute } from '@/authedApp/appRoutes';
import type { AuthedUser } from '@/AuthedApp.types';
import type { NavigateToPage } from '@/authedApp/useNavigateToPage';

/**
 * What the app shell provides to everything under it: the signed-in person and
 * the navigation. A test that renders a page the shell hosts (the admin
 * dashboard, the hub) wraps it here, as AuthedApp does, so the components under
 * the page read them from context the way they do in the app. The route is the
 * one the test set the address to.
 */
export function withShell(node: React.ReactNode, { user = null, onNavigate }: { user?: object | null; onNavigate: NavigateToPage }) {
    const route = matchAppRoute(window.location.pathname, window.location.search);
    return (
        <SessionProvider user={user as AuthedUser | null}>
            <NavigationProvider navigateToPage={onNavigate} route={route}>{node}</NavigationProvider>
        </SessionProvider>
    );
}
