/**
 * Fetch the account's language and keep it current.
 *
 * The phone's counterpart to the web's useTranslation boot: resolve which
 * locale this account renders in, pull that catalogue from the server, cache
 * it. Renders nothing.
 *
 * Mounted inside <AuthProvider> because /api/languages/user/strings/<locale>
 * requires a session, and because the organisation's default locale — the
 * thing that makes a Dutch workspace's phone Dutch without anyone choosing —
 * only arrives with one.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { deviceLocale, hydrate, resolveLocale, setCatalogue, storedLocale, type Catalogue } from './store';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { listLocales, settingsKeys } from '../features/settings/api';

export function LocaleSync(): null {
    const { stage } = useAuth();
    const signedIn = stage.kind === 'signed-in';

    // Paint the cached catalogue immediately, before anything is fetched.
    useEffect(() => {
        void hydrate();
    }, []);

    const locales = useQuery({
        queryKey: settingsKeys.locales,
        queryFn: ({ signal }) => listLocales(signal),
        enabled: signedIn,
        staleTime: 30 * 60_000,
        retry: 1,
    });

    const chosen = useQuery({
        queryKey: ['i18n', 'resolved', locales.data?.map((l) => l.code).join(',') ?? ''],
        queryFn: async () => {
            const available = (locales.data ?? []).map((l) => l.code);
            const orgDefault = (locales.data ?? []).find((l) => l.isOrgDefault)?.code ?? null;
            return resolveLocale({
                stored: await storedLocale(),
                orgDefault,
                device: deviceLocale(),
                available,
            });
        },
        enabled: signedIn && Boolean(locales.data),
        staleTime: Infinity,
    });

    const locale = chosen.data;

    const catalogue = useQuery({
        queryKey: ['i18n', 'strings', locale],
        // English IS the catalogue's own fallback layer, so there is nothing to
        // fetch for it — every `t()` call already carries the English literal.
        enabled: signedIn && Boolean(locale) && locale !== 'en',
        queryFn: ({ signal }) =>
            api.get<Catalogue>(`/api/languages/user/strings/${encodeURIComponent(locale as string)}`, {
                signal,
            }),
        staleTime: 30 * 60_000,
        retry: 1,
    });

    useEffect(() => {
        if (locale && catalogue.data) setCatalogue(locale, catalogue.data);
    }, [locale, catalogue.data]);

    return null;
}
