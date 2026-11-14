import { useSyncExternalStore } from 'react';

/**
 * The in-house router: the browser history as a store.
 *
 * The page a person sees is derived from the address (authedApp/appRoutes.ts
 * holds the table); this module only moves the address and tells React when
 * it moved. Every in-app navigation goes through navigate(); Back and Forward
 * arrive through popstate. A pushState made elsewhere (a page rewriting its
 * own query string, a chat shortening its URL) is not published until the next
 * navigate() or popstate: the shell derives its page from the moves it is told
 * about, so a page that touches the address bar for its own bookkeeping cannot
 * swap the page underneath itself.
 *
 * The History API has no params, patterns or back/forward hooks of its own,
 * which is all this app needs, so there is no library behind this file.
 */
export interface RouteLocation {
    pathname: string;
    search: string;
    hash: string;
    /** The history.state the entry was written with. */
    state: unknown;
}

export interface NavigateOptions {
    /** Rewrite the current entry instead of adding one. */
    replace?: boolean;
    /** Stored as history.state; pages read it back on popstate. */
    state?: unknown;
}

type Listener = () => void;

const listeners = new Set<Listener>();
let current: RouteLocation | null = null;

function readLocation(): RouteLocation {
    const { pathname, search, hash } = window.location;
    return { pathname, search, hash, state: window.history.state };
}

/** The address as last published. With nobody listening yet it is whatever the browser says. */
export function getLocation(): RouteLocation {
    if (listeners.size === 0 || current === null) current = readLocation();
    return current;
}

function publish(): void {
    current = readLocation();
    for (const listener of listeners) listener();
}

export function subscribeLocation(listener: Listener): () => void {
    if (listeners.size === 0) {
        window.addEventListener('popstate', publish);
        current = readLocation();
    }
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener('popstate', publish);
    };
}

/** pathname + search of an address, so a hash difference alone is not a new entry. */
function withoutHash(href: string): string {
    const url = new URL(href, window.location.origin);
    return url.pathname + url.search;
}

/**
 * Move to `to` (a path with optional query and hash). The same address is not
 * written twice in a row, so a page that asks for where it already is does not
 * grow the history; the move is still published, so state derived from the
 * address is rebuilt.
 */
export function navigate(to: string, { replace = false, state = null }: NavigateOptions = {}): void {
    const same = withoutHash(to) === window.location.pathname + window.location.search;
    if (replace) window.history.replaceState(state, '', to);
    else if (!same) window.history.pushState(state, '', to);
    publish();
}

/** Publish the address again without moving: what it means has changed (a route table grew). */
export function refreshLocation(): void {
    publish();
}

/** The current address, re-rendering on every navigate() and on popstate. */
export function useLocation(): RouteLocation {
    return useSyncExternalStore(subscribeLocation, getLocation, getLocation);
}
