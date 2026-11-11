/**
 * A URL per screen of a running app: `#/s/<screenId>?p.<key>=<value>`.
 *
 * Screen and screen params are React state in the run hosts (AppRunPage,
 * PublicAppPage). This module is the pure half of mirroring that state into
 * the address bar, so the browser's Back/Forward buttons move between screens
 * and a link opens a screen with its params. The hook that drives it is
 * useScreenRoute.ts; only RunSurface uses it, so the editor canvas, the editor
 * preview and the headless screenshot never touch the URL.
 *
 * The fragment, not the path: it never reaches a server (no request, no
 * Referer), and every host keeps its own path and query untouched — the
 * Nextcloud app-menu embed carries the app id in `?ncStudioApp=`, a draft
 * preview in `?draft=1`.
 *
 * A URL can only carry text, so only string, number and boolean params are
 * written to it. The exact params of an entry this page pushed itself also
 * ride in history.state, so Back restores numbers, lists and records as they
 * were; a link opened cold gets the text form.
 */

const ROUTE_PREFIX = '#/s/';
const PARAM_PREFIX = 'p.';
const STATE_KEY = 'bfAppScreen';
// Keys that would reach Object.prototype through a plain assignment.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type ScreenParams = Record<string, unknown>;

interface ScreenRoute {
    screenId: string;
    params: ScreenParams;
}

interface RouteScreen {
    id?: string | null;
    visibleToRoles?: string[];
}

interface RouteDefinition {
    screens?: RouteScreen[] | null;
}

function urlValue(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

/** The fragment for a screen: params that cannot be written as text are left out. */
export function formatScreenHash(screenId: string, params?: ScreenParams | null): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params || {})) {
        const text = urlValue(value);
        if (text !== null && key) query.append(`${PARAM_PREFIX}${key}`, text);
    }
    const qs = query.toString();
    return `${ROUTE_PREFIX}${encodeURIComponent(screenId)}${qs ? `?${qs}` : ''}`;
}

/** A fragment back into a route; null when it is not one of ours. */
export function parseScreenHash(hash: string | null | undefined): ScreenRoute | null {
    if (!hash || !hash.startsWith(ROUTE_PREFIX)) return null;
    const rest = hash.slice(ROUTE_PREFIX.length);
    const q = rest.indexOf('?');
    const rawId = q === -1 ? rest : rest.slice(0, q);
    let screenId: string;
    try { screenId = decodeURIComponent(rawId); } catch { return null; }
    if (!screenId) return null;
    const params: ScreenParams = {};
    if (q !== -1) {
        for (const [name, value] of new URLSearchParams(rest.slice(q + 1))) {
            if (!name.startsWith(PARAM_PREFIX)) continue;
            const key = name.slice(PARAM_PREFIX.length);
            if (!key || UNSAFE_KEYS.has(key)) continue;
            params[key] = value;
        }
    }
    return { screenId, params };
}

/**
 * The run view's role for the presentational screen gate: the owner sees
 * everything; a viewer the server resolved no role for gets a sentinel no
 * role key can equal (keys start with a lowercase letter), never null —
 * null would disable the gate.
 */
export function previewRoleFor(viewer: { isOwner?: boolean; roleKey?: string | null } | null | undefined): string {
    if (viewer?.isOwner) return 'owner';
    return viewer?.roleKey || '__no_role__';
}

// The same rule as AppRenderer's screen gate: no visibleToRoles means
// everyone, the owner passes every gate.
function roleMaySee(screen: RouteScreen, previewRole: string): boolean {
    if (previewRole === 'owner') return true;
    const gate = screen.visibleToRoles;
    return !Array.isArray(gate) || gate.length === 0 || gate.includes(previewRole);
}

/** Whether a screen exists in this definition at all. */
export function hasScreen(definition: RouteDefinition | null | undefined, screenId: string): boolean {
    return (definition?.screens || []).some((s) => s?.id === screenId);
}

/**
 * Whether a route from the URL may be shown as is. The definition a host has
 * is already the viewer's surface (the public page only receives its public
 * screens), so "exists here and the role gate lets this viewer in" is the
 * whole test.
 */
function reachable(definition: RouteDefinition | null | undefined, screenId: string, previewRole: string): boolean {
    const screen = (definition?.screens || []).find((s) => s?.id === screenId);
    return !!screen && roleMaySee(screen, previewRole);
}

function stateRoute(state: unknown): ScreenRoute | null {
    if (!state || typeof state !== 'object') return null;
    const saved = (state as Record<string, unknown>)[STATE_KEY];
    if (!saved || typeof saved !== 'object') return null;
    const { screenId, params } = saved as { screenId?: unknown; params?: unknown };
    if (typeof screenId !== 'string') return null;
    return { screenId, params: params && typeof params === 'object' ? params as ScreenParams : {} };
}

interface LocationRoute extends ScreenRoute {
    /** The fragment named a route this viewer may not open: the URL should be cleaned. */
    refused: boolean;
}

/**
 * The route the current location asks for, or the home screen when it asks
 * for nothing or for a screen this viewer cannot reach. Prefers the exact
 * params saved in history.state when that entry's fragment is still the one
 * this module wrote for them.
 */
export function routeFromLocation(
    definition: RouteDefinition | null | undefined,
    homeScreenId: string | null,
    previewRole: string,
): LocationRoute | null {
    const hash = window.location.hash;
    const parsed = parseScreenHash(hash);
    const home = homeScreenId ? { screenId: homeScreenId, params: {} } : null;
    if (!parsed) return home ? { ...home, refused: false } : null;
    if (!reachable(definition, parsed.screenId, previewRole)) {
        return home ? { ...home, refused: true } : null;
    }
    const saved = stateRoute(window.history.state);
    if (saved && formatScreenHash(saved.screenId, saved.params) === hash) {
        return { ...saved, refused: false };
    }
    return { ...parsed, refused: false };
}

/**
 * The screen a host opens first: what the URL names when this viewer may
 * see it, the home screen otherwise (`screenId` null only when the app has
 * no screen at all — the renderer then shows nothing, as before).
 */
export function openingRoute(
    definition: RouteDefinition | null | undefined,
    homeScreenId: string | null,
    previewRole: string,
): { screenId: string | null; params: ScreenParams } {
    return routeFromLocation(definition, homeScreenId, previewRole) || { screenId: homeScreenId, params: {} };
}

/** The history.state for a pushed screen: what was there, plus our route. */
export function screenHistoryState(route: ScreenRoute, withParams: boolean): Record<string, unknown> {
    const current = window.history.state;
    const base = current && typeof current === 'object' ? current as Record<string, unknown> : {};
    return { ...base, [STATE_KEY]: { screenId: route.screenId, params: withParams ? route.params : {} } };
}

/** The current URL without any fragment. */
export function urlWithoutHash(): string {
    return `${window.location.pathname}${window.location.search}`;
}
