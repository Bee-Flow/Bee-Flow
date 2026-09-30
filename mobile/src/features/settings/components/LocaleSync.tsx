/**
 * Fetch the account's language and keep it current.
 *
 * The phone's counterpart to the web's useTranslation boot: resolve which
 * locale this account renders in, pull that catalogue from the server, cache
 * it. Renders nothing.
 *
 * Mounted inside <AuthProvider> because /api/languages/user/strings/<locale>
 * requires a session, and because the organisation's default locale only
 * arrives with one. Before that session exists (the login, MFA, PIN and
 * approval steps) the server's public catalogue stands in for it
 * (usePublicCatalogue), as the web's login page does.
 *
 * It lives in this feature, not in core/i18n, because the locale list is a
 * settings endpoint; core/i18n holds the catalogue store it feeds.
 */

import { useEffect } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { hydrate, setCatalogue } from '@/core/i18n';

import { useAccountLocale } from '../hooks/useAccountLocale';
import { usePublicCatalogue } from '../hooks/usePublicCatalogue';
import { wantsPublicCatalogue } from '../model/publicLocale';

export function LocaleSync(): null {
    const { stage } = useAuth();
    const signedIn = stage.kind === 'signed-in';

    // Paint the cached catalogue immediately, before anything is fetched.
    useEffect(() => {
        void hydrate();
    }, []);

    usePublicCatalogue(wantsPublicCatalogue(stage.kind));

    const { locale, catalogue } = useAccountLocale(signedIn);

    useEffect(() => {
        // The account's catalogue wins once signed in. `signedIn` is a
        // dependency so that it is installed again on every sign-in, over the
        // public one the login put up, even when the query answers from cache.
        if (!signedIn) return;
        // English has no catalogue to fetch (every t() carries it), so it is
        // installed empty — otherwise choosing English after Dutch kept Dutch.
        if (locale === 'en') setCatalogue('en', {});
        else if (locale && catalogue) setCatalogue(locale, catalogue);
    }, [signedIn, locale, catalogue]);

    return null;
}
