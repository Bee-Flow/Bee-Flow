/**
 * The Settings hub's queries: locales, the changelog, and the two server
 * probes. Options that differ per screen are spread only when given, because
 * an explicit `undefined` would override the query client's defaults.
 */

import { useQuery } from '@tanstack/react-query';

import { checkHealth, checkServerSupport, getServerUrl } from '@/core/api/server';

import { getLocaleStrings, listLocales, listReleaseNotes } from '../api/endpoints';
import { settingsKeys } from '../api/keys';

interface ProbeOptions {
    enabled?: boolean;
    staleTime?: number;
    refetchInterval?: number;
}

function given<T extends object>(options: T): Partial<T> {
    return Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** The workspace's locales. `retry` defaults to the client's own rule. */
export function useLocales(options: { enabled?: boolean; staleTime?: number; retry?: number } = {}) {
    return useQuery({
        queryKey: settingsKeys.locales,
        queryFn: ({ signal }) => listLocales(signal),
        ...given(options),
    });
}

export function useLocaleStrings(locale: string | undefined, enabled: boolean) {
    return useQuery({
        queryKey: settingsKeys.localeStrings(locale),
        // English IS the catalogue's own fallback layer, so there is nothing to
        // fetch for it — every `t()` call already carries the English literal.
        enabled: enabled && Boolean(locale) && locale !== 'en',
        queryFn: ({ signal }) => getLocaleStrings(locale as string, signal),
        staleTime: 30 * 60_000,
        retry: 1,
    });
}

export function useReleaseNotes() {
    return useQuery({
        queryKey: settingsKeys.releaseNotes,
        queryFn: ({ signal }) => listReleaseNotes(signal),
        staleTime: 30 * 60_000,
        retry: false,
    });
}

/**
 * `/api/health` on the server this app is pointed at. Public, and it answers
 * `{status:'ok', appVersion}`, so it tells "wrong address" from "right
 * address, not signed in" — which a 401 from anywhere else would not.
 */
export function useServerHealth(options: ProbeOptions = {}) {
    return useQuery({
        queryKey: settingsKeys.health,
        queryFn: () => {
            const server = getServerUrl();
            return server ? checkHealth(server) : Promise.resolve(null);
        },
        retry: false,
        ...given(options),
    });
}

/**
 * The MIN_SERVER_BUILD capability probe — not a version compare, because the
 * server has no orderable version number. Soft on purpose: an old server gets
 * a warning, not a locked app.
 */
export function useServerSupport() {
    return useQuery({
        queryKey: settingsKeys.serverSupport,
        queryFn: () => {
            const server = getServerUrl();
            return server ? checkServerSupport(server) : Promise.resolve(null);
        },
        staleTime: 60_000,
        retry: false,
    });
}
