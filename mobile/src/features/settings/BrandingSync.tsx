/**
 * Teach the phone what the account looks like.
 *
 * The web resolves its theme from `/api/branding/effective` on every load and
 * defaults to `light` when nothing is stored. The phone did neither: its
 * ThemeProvider hydrated from AsyncStorage and, with nothing stored, followed
 * Android's own light/dark switch. `getBranding()` existed and had exactly one
 * caller — the Settings → Appearance screen — where its answer was used to draw
 * that screen and then discarded.
 *
 * So an account set to light opened as a black app, an admin's brand accent
 * reached the phone only if the user went looking for it in Settings, and the
 * two clients disagreed about the same account. This component closes that: it
 * is the phone's equivalent of the web's ThemeContext boot fetch.
 *
 * It renders nothing. It is mounted inside <AuthProvider> because which
 * endpoint to call depends on whether there is a session — and it must be, or
 * it would fire before the session token is installed and take a 401 on every
 * cold start.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { getBranding, getPublicBranding, settingsKeys } from './api';
import { useAuth } from '../../auth/AuthProvider';
import { useTheme } from '../../theme/ThemeProvider';

export function BrandingSync(): null {
    const { stage } = useAuth();
    const { applyServerBranding } = useTheme();

    // Before there is a session the only readable branding is the public
    // subset, which is what makes the LOGIN screen match the org too — the
    // screen a new user sees first, and the one where "this looks like a
    // different product" costs the most.
    const signedIn = stage.kind === 'signed-in';
    const known = stage.kind !== 'loading' && stage.kind !== 'needs-server';

    const query = useQuery({
        queryKey: signedIn ? settingsKeys.branding : settingsKeys.brandingPublic,
        queryFn: ({ signal }) => (signedIn ? getBranding(signal) : getPublicBranding(signal)),
        // Only once the auth layer has settled: firing during 'loading' races
        // the session-token install and answers 401 for no reason.
        enabled: known,
        staleTime: 5 * 60_000,
        // A themed app that cannot reach its server is not broken — it just
        // keeps the theme it cached. Retrying hard would delay nothing useful.
        retry: 1,
    });

    useEffect(() => {
        if (query.data) applyServerBranding(query.data);
    }, [query.data, applyServerBranding]);

    return null;
}
