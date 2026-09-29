/**
 * URL ⟷ component-state helpers for the settings surfaces.
 *
 * The app uses a custom history.pushState approach (react-router is not mounted).
 * These hooks give a small, consistent API for any settings panel that wants its
 * active tab / sub-tab to be bookmarkable and back-button-aware.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

/** Internal tab id → URL segment, e.g. { org_users: 'users' }. */
export type TabAliases = Record<string, string>;

export interface NavigateOptions {
    replace?: boolean;
}

export interface UseUrlTabOptions {
    /** Path prefix, e.g. '/app/settings' or '/app/org-settings/users'. */
    basePath: string;
    /** Accepted tab ids; anything else falls back to defaultValue. */
    validValues: readonly string[];
    defaultValue: string;
    aliases?: TabAliases;
}

function splitPath(pathname: string): string[] {
    return pathname.replace(/^\/+|\/+$/g, '').split('/');
}

function invertAliases(aliases: TabAliases): Record<string, string> {
    const urlToId: Record<string, string> = {};
    for (const [id, urlName] of Object.entries(aliases)) urlToId[urlName] = id;
    return urlToId;
}

/** Syncs a tab-id value with a URL path segment. */
export function useUrlTab(
    { basePath, validValues, defaultValue, aliases = {} }: UseUrlTabOptions,
): [string, (value: string, opts?: NavigateOptions) => void] {
    const urlToId = useMemo(() => invertAliases(aliases), [aliases]);

    const readFromUrl = useCallback(() => {
        const baseParts = splitPath(basePath);
        const pathParts = splitPath(window.location.pathname);
        // Find the segment that sits directly after basePath.
        for (let i = 0; i < baseParts.length; i++) {
            if (pathParts[i] !== baseParts[i]) return defaultValue;
        }
        const candidateUrl = pathParts[baseParts.length];
        if (!candidateUrl) return defaultValue;
        const candidate = urlToId[candidateUrl] || candidateUrl;
        return validValues.includes(candidate) ? candidate : defaultValue;
    }, [basePath, defaultValue, validValues, urlToId]);

    const [value, setValueState] = useState(readFromUrl);

    const setValue = useCallback((v: string, { replace = false }: NavigateOptions = {}) => {
        setValueState(v);
        const url = `${basePath}/${aliases[v] || v}`;
        const method = replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', url);
    }, [basePath, aliases]);

    useEffect(() => {
        const onPop = () => setValueState(readFromUrl());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [readFromUrl]);

    return [value, setValue];
}

/**
 * Reads and writes a single query-string parameter on the current URL.
 * Used by overlay-style UI (the Agent editor modal) that sits on top of another route.
 */
export function useUrlQueryParam(
    name: string,
): [string | null, (value: string | null | undefined, opts?: NavigateOptions) => void] {
    const read = useCallback(() => {
        const params = new URLSearchParams(window.location.search);
        return params.get(name);
    }, [name]);

    const [value, setValueState] = useState(read);

    const setValue = useCallback((
        v: string | null | undefined,
        { replace = false }: NavigateOptions = {},
    ) => {
        setValueState(v ?? null);
        const params = new URLSearchParams(window.location.search);
        if (v === null || v === undefined || v === '') {
            params.delete(name);
        } else {
            params.set(name, v);
        }
        const qs = params.toString();
        const url = window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash;
        const method = replace ? 'replaceState' : 'pushState';
        window.history[method]({}, '', url);
    }, [name]);

    useEffect(() => {
        const onPop = () => setValueState(read());
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    }, [read]);

    return [value, setValue];
}
