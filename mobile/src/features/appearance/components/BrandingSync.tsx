/**
 * Teach the phone what the account looks like.
 *
 * The web resolves its theme from `/api/branding/effective` on every load and
 * defaults to `light` when nothing is stored. The phone used to do neither:
 * its ThemeProvider hydrated from AsyncStorage and, with nothing stored,
 * followed Android's own light/dark switch — so an account set to light opened
 * as a black app, and an admin's brand accent reached the phone only if the
 * user went looking for it in Settings. This is the phone's equivalent of the
 * web's ThemeContext boot fetch.
 *
 * It renders nothing. It is mounted inside <AuthProvider> because which
 * endpoint to call depends on whether there is a session — and it must be, or
 * it would fire before the session token is installed and take a 401 on every
 * cold start.
 */

import { useEffect } from 'react';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTheme } from '@/core/theme/ThemeProvider';

import { useActiveBranding } from '../hooks/queries';

export function BrandingSync(): null {
    const { stage } = useAuth();
    const { applyServerBranding } = useTheme();

    // Before there is a session the only readable branding is the public
    // subset, which is what makes the LOGIN screen match the org too — the
    // screen a new user sees first, and the one where "this looks like a
    // different product" costs the most.
    const query = useActiveBranding({
        signedIn: stage.kind === 'signed-in',
        known: stage.kind !== 'loading' && stage.kind !== 'needs-server',
    });

    useEffect(() => {
        if (query.data) applyServerBranding(query.data);
    }, [query.data, applyServerBranding]);

    return null;
}
