/**
 * Signing in through Google, Microsoft or Nextcloud, and every way that can end.
 *
 * The in-flight flow is aborted when the login screen unmounts. There is
 * deliberately no "clear the error on unmount" effect: `clearError` is a fresh
 * closure on every AuthProvider render, so an effect depending on it would
 * re-run whenever `error` changes and wipe the message before anyone read it.
 */

import { useEffect, useRef, useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { adoptSessionToken } from '@/core/auth/sessionToken';
import { translate } from '@/core/i18n';

import { SSO_LABELS, SsoCancelledError, startSsoLogin, type SsoProvider } from '../api/sso';

/**
 * Backing out is not a failure and needs no banner — the button stopping its
 * spinner is the whole story. Anything else does: "the spinner stopped and
 * nothing happened" is precisely the failure a user cannot act on.
 */
function failureMessage(err: unknown, provider: SsoProvider): string | null {
    if (err instanceof SsoCancelledError) {
        return err.reason === 'user-cancelled'
            ? null
            : translate('mobile.onboarding.sso_incomplete', '{provider} sign-in did not complete. Please try again.', {
                  provider: SSO_LABELS[provider],
              });
    }
    return describeError(err).message;
}

export function useSsoSignIn() {
    const { refresh, clearError } = useAuth();
    const [provider, setProvider] = useState<SsoProvider | null>(null);
    /** Set only when SSO signed in on the server but not in this app — see below. */
    const [stranded, setStranded] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const abort = useRef<AbortController | null>(null);

    useEffect(() => () => abort.current?.abort(), []);

    const start = async (next: SsoProvider) => {
        clearError();
        setStranded(null);
        setError(null);
        setProvider(next);
        const controller = new AbortController();
        abort.current = controller;
        try {
            const result = await startSsoLogin(next, controller.signal);
            // The token IS the session — the bridge sets no cookie this app can
            // see — so it is adopted before `refresh()`, which makes the first
            // authenticated request.
            await adoptSessionToken(result.sessionToken);
            await refresh();
            // `refresh()` moves the stage and the gate replaces this route, so
            // reaching this line means the token was claimed and the server
            // still did not recognise the session (a bridge token that expired
            // in between, or no shared Redis across processes). Rare, but it
            // has to say something a person can act on. (See api/sso.ts.)
            setStranded(result.user?.displayName || SSO_LABELS[next]);
        } catch (err) {
            const message = failureMessage(err, next);
            // Inline rather than a toast: an error the user cannot re-read is
            // an error they cannot act on.
            if (message !== null) {
                setStranded(null);
                setError(message);
            }
        } finally {
            setProvider(null);
            abort.current = null;
        }
    };

    return { provider, stranded, error, start };
}
