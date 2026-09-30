/**
 * Going to an in-app address from anywhere — a notification, a link in a chat
 * answer, a search hit, the A–Z map, a drawer row — without stacking a second
 * copy of the drawer.
 *
 * The tab roots (DRAWER_PATHS) live inside the navigation drawer, and the
 * drawer is ONE screen of the root Stack; every other screen is pushed over
 * it. From a pushed screen (the inbox, a chat, search), expo-router resolves a
 * tab address to "the root Stack's (drawer) route" — and both `push` and
 * `navigate` then ADD one, because a stack only returns to an existing route
 * that is the current one. The result was a second drawer and tab bar on top
 * of the first, its header showing the drawer toggle where Back belongs.
 *
 * So a tab address pops back to the drawer that is already there
 * (`dismissTo`), and switches its tab; with nothing to dismiss — the caller is
 * inside the drawer already — `navigate` switches the tab. Every other address
 * is pushed, as before. openRoute.router.test.tsx pins this against the real
 * router.
 */

import type { Href } from 'expo-router';

/** The URLs that render inside the drawer: the tab roots (features/shell's TABS, held equal by its test). */
export const DRAWER_PATHS: ReadonlySet<string> = new Set(['/', '/record', '/studio']);

/**
 * The URL an href stands for: route groups dropped, query and hash cut, no
 * trailing slash — `/(tabs)/record?x=1` → `/record`, `/(tabs)` → `/`.
 */
export function routePath(href: string): string {
    const [path = ''] = href.split(/[?#]/);
    const segments = path.split('/').filter((s) => s && !(s.startsWith('(') && s.endsWith(')')));
    return `/${segments.join('/')}`;
}

/** Does this address render inside the drawer (a tab root)? */
export function isDrawerPath(href: string): boolean {
    return DRAWER_PATHS.has(routePath(href));
}

/** The part of expo-router's router this needs (useRouter() satisfies it). */
export interface RouteOpener {
    push: (href: Href) => void;
    navigate: (href: Href) => void;
    dismissTo: (href: Href) => void;
    canDismiss: () => boolean;
}

/** Open `href`: a tab root is switched to (never stacked), anything else is pushed. */
export function openRoute(router: RouteOpener, href: string): void {
    const to = href as Href;
    if (!isDrawerPath(href)) router.push(to);
    else if (router.canDismiss()) router.dismissTo(to);
    else router.navigate(to);
}
