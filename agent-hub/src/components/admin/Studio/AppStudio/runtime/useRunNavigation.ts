import { useCallback, useEffect, useRef, useState } from 'react';
import {
    formatScreenHash, hasScreen, routeFromLocation, screenHistoryState, urlWithoutHash,
    type ScreenParams,
} from './screenRoute';

interface ScreenRouteDefinition {
    screens?: { id?: string | null; visibleToRoles?: string[] }[] | null;
}

interface UseScreenRouteOptions {
    /** Off: the hook never reads or writes the URL (today's behaviour). */
    enabled: boolean;
    definition: ScreenRouteDefinition | null | undefined;
    /** Where an empty or refused fragment lands (the public page: its entry screen). */
    homeScreenId: string | null;
    previewRole: string;
    /** Show a screen without touching history: the host's screen and params setters. */
    show: (screenId: string, params: ScreenParams) => void;
}

/**
 * Mirrors the run view's screen into the address bar (see screenRoute.ts).
 * Returns the half the host's ONE navigation callback calls after it changed
 * the screen: it pushes a history entry. The other half listens for Back and
 * Forward and shows what the entry names, through the same route check a
 * cold link gets: a screen that does not exist here, or that the viewer's
 * role may not see, shows the home screen and the fragment is dropped.
 *
 * The initial screen is the host's to pick (routeFromLocation in its load),
 * so a deep link renders its own screen on the first paint instead of
 * flashing the home screen and fetching its data first.
 */
function useScreenRoute({ enabled, definition, homeScreenId, previewRole, show }: UseScreenRouteOptions) {
    const live = useRef({ definition, homeScreenId, previewRole, show });
    useEffect(() => { live.current = { definition, homeScreenId, previewRole, show }; });

    useEffect(() => {
        if (!enabled) return undefined;
        // Entries of another page (an app→app switch, leaving the app) are
        // the shell's to handle; this listener only answers its own path.
        const base = urlWithoutHash();
        const opened = routeFromLocation(live.current.definition, live.current.homeScreenId, live.current.previewRole);
        if (opened?.refused) window.history.replaceState(window.history.state, '', base);
        const onPop = () => {
            if (urlWithoutHash() !== base) return;
            const now = live.current;
            const route = routeFromLocation(now.definition, now.homeScreenId, now.previewRole);
            if (!route) return;
            if (route.refused) window.history.replaceState(window.history.state, '', base);
            now.show(route.screenId, route.params);
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [enabled]);

    return useCallback((screenId: string, params: ScreenParams) => {
        if (!enabled || !hasScreen(live.current.definition, screenId)) return;
        const hash = formatScreenHash(screenId, params);
        const url = `${urlWithoutHash()}${hash}`;
        // The same address again (a nav click on the current screen) is not
        // a step Back should have to undo; its exact params still refresh.
        const write = window.location.hash === hash
            ? (state: Record<string, unknown>) => window.history.replaceState(state, '', url)
            : (state: Record<string, unknown>) => window.history.pushState(state, '', url);
        const route = { screenId, params };
        // A param the browser cannot store (structured clone) only loses its
        // exact form; the entry itself is still written.
        try { write(screenHistoryState(route, true)); } catch { write(screenHistoryState(route, false)); }
    }, [enabled]);
}

interface UseRunNavigationOptions {
    urlRoute: boolean;
    definition: ScreenRouteDefinition | null | undefined;
    homeScreenId: string | null;
    previewRole: string;
    /** The host's screen setter. */
    onNavigate: (screenId: string) => void;
    /** The params of the screen the host opened first (from a screen link). */
    initialScreenParams: ScreenParams | null;
}

/**
 * The run view's screen params and its ONE navigation callback, which the
 * shell's nav, navigate actions and navigate effects all call. With
 * `urlRoute` it also writes the screen into the URL and follows Back and
 * Forward; without it, it is exactly the callback the run view always had.
 */
export default function useRunNavigation({
    urlRoute, definition, homeScreenId, previewRole, onNavigate, initialScreenParams,
}: UseRunNavigationOptions) {
    const [screenParams, setScreenParams] = useState<ScreenParams>(() => initialScreenParams || {});

    const show = useCallback((screenId: string, params: ScreenParams) => {
        setScreenParams(params);
        onNavigate(screenId);
    }, [onNavigate]);

    const pushRoute = useScreenRoute({ enabled: urlRoute, definition, homeScreenId, previewRole, show });

    const handleNavigate = useCallback((screenId: string, params?: unknown) => {
        const next: ScreenParams = params && typeof params === 'object' ? params as ScreenParams : {};
        show(screenId, next);
        pushRoute(screenId, next);
    }, [show, pushRoute]);

    return { screenParams, handleNavigate };
}
