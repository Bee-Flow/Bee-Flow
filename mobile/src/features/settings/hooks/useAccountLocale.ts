/**
 * Which locale this account renders in, and its strings.
 *
 * Same order as the web: an explicit choice on this device, else the
 * organisation's default, else the phone's language — among the locales the
 * workspace actually offers. The organisation's default only arrives with a
 * session, which is what makes a Dutch workspace's phone Dutch without anyone
 * choosing.
 */

import { useQuery } from '@tanstack/react-query';

import { deviceLocale, resolveLocale, storedLocale } from '@/core/i18n';

import { useLocales, useLocaleStrings } from './queries';
import { settingsKeys } from '../api/keys';
import type { Locale } from '../model/types';

function useResolvedLocale(locales: Locale[] | undefined, enabled: boolean) {
    return useQuery({
        queryKey: settingsKeys.resolvedLocale(locales?.map((l) => l.code).join(',') ?? ''),
        queryFn: async () =>
            resolveLocale({
                stored: await storedLocale(),
                orgDefault: (locales ?? []).find((l) => l.isOrgDefault)?.code ?? null,
                device: deviceLocale(),
                available: (locales ?? []).map((l) => l.code),
            }),
        enabled: enabled && Boolean(locales),
        staleTime: Infinity,
    });
}

/** The resolved locale and its catalogue, once signed in. */
export function useAccountLocale(signedIn: boolean) {
    const locales = useLocales({ enabled: signedIn, staleTime: 30 * 60_000, retry: 1 });
    const chosen = useResolvedLocale(locales.data, signedIn);
    const catalogue = useLocaleStrings(chosen.data, signedIn);
    return { locale: chosen.data, catalogue: catalogue.data };
}
