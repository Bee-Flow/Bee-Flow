import { useCallback, useEffect, useRef } from 'react';
import { getLocation, navigate } from '../router/history';
import { whenMayNavigate } from '../utils/unsavedNavigation';
import { resolveNavigationTarget } from './navigationTargets';

export type NavigateToPage = (page: string, options?: { replace?: boolean }) => void;

/**
 * The app-shell `navigateToPage`: a page name (navigationTargets.ts) turned
 * into one router move, behind the unsaved-changes guard. Created once, so the
 * pages that keep it in an effect's dependencies do not re-run on every render;
 * what it needs from the current render is read through refs.
 */
export function useNavigateToPage({ isMobile, isConsumerAccount }: { isMobile: boolean; isConsumerAccount: boolean }): NavigateToPage {
    const ctxRef = useRef({ isMobile, isConsumerAccount });
    useEffect(() => { ctxRef.current = { isMobile, isConsumerAccount }; }, [isMobile, isConsumerAccount]);
    return useCallback<NavigateToPage>((page, options = {}) => whenMayNavigate(() => {
        const { path, state, replace } = resolveNavigationTarget(page, options, { ...ctxRef.current, currentPathname: getLocation().pathname });
        navigate(path, { replace, state });
    }), []);
}
