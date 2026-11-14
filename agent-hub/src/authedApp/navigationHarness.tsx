import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { expect, vi } from 'vitest';
import AppRoot from '../App';
import { queryClient } from '../api/queryClient';
import { TranslationProvider } from '../hooks/useTranslation';
import { applyNcDeepLink } from '../utils/ncDeepLink';

/**
 * The one render harness of the navigation contract (navigationInventory.ts and
 * the navigation.*.test.tsx files next to it).
 *
 * It boots the real entry (App → AppRoutes → AuthedApp → AgentHub and the real
 * pages) at an address, against a fake server answered at the network boundary
 * (global fetch), and hands back the navigation call the app gives its pages.
 * Nothing in the tree is swapped through the module system, so a router can
 * replace AuthedApp's state and these tests still describe what a person sees
 * at an address.
 */

export interface SessionUser {
    id: string;
    username: string;
    role: string;
    isAdmin: boolean;
    organizationId: string | null;
    permissions: string[];
}

const ADMIN: SessionUser = {
    id: 'u-admin', username: 'ada', role: 'admin', isAdmin: true, organizationId: 'org-1', permissions: ['all'],
};
export const MEMBER: SessionUser = {
    id: 'u-member', username: 'max', role: 'user', isAdmin: false, organizationId: 'org-1', permissions: [],
};

export interface BootOptions {
    /** The signed-in person; null = no session (the sign-in page). */
    user?: SessionUser | null;
}

const PROJECT = { id: 'p1', name: 'Onboarding', permission: 'owner', kind: 'workspace', icon: '📁', color: '#22c55e' };

// Records that do not exist (a page at their address shows its not-found state).
const MISSING = ['/api/automation/form/tok1', '/runtime', '/api/automation/approvals/apr1', '/agents/ag1', '/api/cowork/cw1'];

// Answers by pathname suffix, ahead of the session defaults below.
const ANSWERS: Record<string, unknown> = {
    // An Enterprise licence, so a page behind a tier shows itself rather than its upgrade notice.
    '/api/license/status': { tier: 'enterprise', source: 'license', features: [], limits: {} },
    // The capabilities the feature-gated pages of the inventory sit behind.
    '/auth/my-entitlements': { tier: 'enterprise', mode: 'self-hosted', effective: { core: ['projects'] }, ceiling: { core: ['projects'] }, registry: [] },
    '/api/projects': [PROJECT],
    '/api/projects/p1': PROJECT,
    '/api/projects/p1/pins': { items: [] },
    '/auth/setup-status': { deploymentMode: 'self-hosted', isSetupComplete: true },
    // A self-hosted install has no marketing site: "/" and one-segment paths hand over to /app.
    '/api/cms/site': { enabled: false, appOnly: true },
};

/** The history entry under every boot: what Back reaches when a page replaced the one it came from. */
export const HISTORY_FLOOR = '/__navigation-test-floor__';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
});

/** The fake server: the session endpoints answer for `user`; any other read is an empty list. */
function fakeServer(user: SessionUser | null) {
    return vi.fn(async (input: RequestInfo | URL) => {
        const { pathname } = new URL(String(input instanceof Request ? input.url : input), window.location.origin);
        if (MISSING.some(suffix => pathname.endsWith(suffix))) return json({ error: 'not found' }, 404);
        for (const [suffix, body] of Object.entries(ANSWERS)) {
            if (pathname.endsWith(suffix)) return json(body);
        }
        if (pathname.endsWith('/auth/user')) {
            return user
                ? json({ authenticated: true, user, featureFlags: { deploymentMode: 'self-hosted' }, encryptionEnabled: false })
                : json({ authenticated: false }, 401);
        }
        if (pathname.endsWith('/auth/my-permissions')) {
            return json({ permissions: user?.permissions || [], groups: [], organizations: [], isHomeOrgAdmin: !!user?.isAdmin });
        }
        if (pathname.endsWith('/setup/diagnostics')) return json({}, 404);
        return json([]);
    });
}

/**
 * Boot the app at `url` the way main.tsx does: the Nextcloud `?ncPath=` swap
 * first, then one render under the app's own QueryClient. Storage starts empty,
 * so a remembered choice of an earlier test cannot pick the page.
 */
function boot(url: string, { user = ADMIN }: BootOptions = {}) {
    window.localStorage.clear();
    window.sessionStorage.clear();
    // A history entry of our own below the first page, so Back from that page
    // lands somewhere this test owns rather than on the previous test's.
    window.history.replaceState(null, '', HISTORY_FLOOR);
    window.history.pushState(null, '', url);
    applyNcDeepLink();
    queryClient.clear();
    vi.stubGlobal('fetch', fakeServer(user));
    return render(
        <QueryClientProvider client={queryClient}>
            <TranslationProvider>
                <AppRoot />
            </TranslationProvider>
        </QueryClientProvider>,
    );
}

type Fiber = {
    memoizedProps?: Record<string, unknown> | null;
    child?: Fiber | null;
    sibling?: Fiber | null;
    /** On the root fiber: the FiberRoot, whose `current` is the committed tree. */
    stateNode?: { current?: Fiber } | null;
};
type Navigate = (target: string, options?: { replace?: boolean }) => void;

/**
 * The navigation call the app hands every page as `onNavigate`, read off the
 * mounted tree: the first component that received one. Read through React's
 * own fiber link on the container, so the test calls exactly what a page calls
 * without replacing any module.
 */
function appNavigate(container: HTMLElement): Navigate {
    const key = Object.keys(container).find(k => k.startsWith('__reactContainer$'));
    if (!key) throw new Error('no React root on the container');
    // The container keeps the root fiber it was created with; after a commit the
    // committed tree may be its alternate, which the FiberRoot names.
    const root: Fiber = Reflect.get(container, key);
    const stack: Fiber[] = [root.stateNode?.current ?? root];
    while (stack.length) {
        const fiber = stack.pop()!;
        const onNavigate = fiber.memoizedProps?.onNavigate;
        if (typeof onNavigate === 'function') {
            return (target, options) => { act(() => { (onNavigate as Navigate)(target, options); }); };
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
    }
    throw new Error('no component with onNavigate is mounted');
}

/** What on screen says which page this is. */
export type Shows =
    | { current: string }          // the navigation item (by test id) marked aria-current="page"
    | { testId: string }
    | { heading: string }
    | { nav: string }              // a navigation landmark, by its accessible name
    | { text: string };

export const HOME: Shows = { heading: 'Welcome to Bee Flow' };

export const WAIT = { timeout: 10_000 };
/** For a check that is expected to fail: its page never arrives, so the full wait is only time. */
export const QUICK = { timeout: 1_500 };

export async function expectShows(shows: Shows, wait = WAIT): Promise<void> {
    if ('current' in shows) {
        await waitFor(() => expect(screen.getByTestId(shows.current)).toHaveAttribute('aria-current', 'page'), wait);
    } else if ('testId' in shows) {
        expect(await screen.findByTestId(shows.testId, {}, wait)).toBeInTheDocument();
    } else if ('heading' in shows) {
        expect(await screen.findByRole('heading', { name: shows.heading }, wait)).toBeInTheDocument();
    } else if ('nav' in shows) {
        expect(await screen.findByRole('navigation', { name: shows.nav }, wait)).toBeInTheDocument();
    } else {
        expect((await screen.findAllByText(shows.text, {}, wait))[0]).toBeInTheDocument();
    }
}

/** The address bar as a page sees it. */
const here = () => window.location.pathname + window.location.search;

export async function expectAt(address: string, wait = WAIT): Promise<void> {
    await waitFor(() => expect(here()).toBe(address), wait);
}

/** Boot at `url` and wait for the first page (the home page unless told otherwise). */
export async function bootAt(url: string, shows: Shows = HOME, options: BootOptions = {}, wait = WAIT) {
    const { container } = boot(url, options);
    await expectShows(shows, wait);
    return { navigate: (target: string) => appNavigate(container)(target) };
}

/** Browser Back / Forward: jsdom moves the history entry and fires popstate on its own task. */
async function traverse(step: () => void): Promise<void> {
    await act(async () => {
        const moved = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }));
        step();
        await moved;
    });
}
export const back = () => traverse(() => window.history.back());
export const forward = () => traverse(() => window.history.forward());

/** A phone: the viewport query useViewport asks answers "mobile". Undone by vi.unstubAllGlobals. */
export function onAPhone(): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query === '(max-width: 767px)', media: query, onchange: null,
        addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
    }));
}
