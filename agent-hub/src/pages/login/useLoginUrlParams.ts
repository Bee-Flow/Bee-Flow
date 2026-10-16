import { useEffect } from 'react';
import type { TranslateFn } from '../../hooks/useTranslation';
import type { Setter } from './loginShared';

interface UrlParamDeps {
    t: TranslateFn;
    setResetToken: Setter<string | null>;
    setVerifiedBanner: Setter<boolean>;
    setError: Setter<string>;
}

/**
 * The query-string redirects that land on the login page: a password-reset link,
 * the email-verification result, SSO provisioning failures and a failed
 * invite redeem. Four effects, in this order.
 */
export function useLoginUrlParams({ t, setResetToken, setVerifiedBanner, setError }: UrlParamDeps): void {
    // Detect a password-reset link (?reset=TOKEN). Capture the token and strip
    // it from the address bar so it can't leak from a copied URL.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const token = params.get('reset');
        if (token) {
            setResetToken(token);
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, []);

    // Detect the email-verification redirect (?verified=1 on success, or
    // ?error=verify_expired / verify_error). The verify endpoint 302s here
    // after flipping the account to active; show a banner and clean the URL.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        if (params.get('verified') === '1') {
            setVerifiedBanner(true);
            window.history.replaceState({}, '', window.location.pathname);
        } else if ((params.get('error') || '').startsWith('verify_')) {
            setError(t('login.verify_link_invalid', 'This verification link is invalid or has expired. Please log in to request a new one.'));
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, [t]);

    useEffect(() => {
        const err = new URLSearchParams(window.location.search).get('error');
        if (err === 'sso_link_required') {
            setError(t('login.sso_link_required', 'Your Microsoft identity needs to be linked by a platform administrator. Contact your administrator, then sign in again.'));
        } else if (err === 'seat_cap_exceeded') {
            setError(t('login.sso_seat_cap_exceeded', 'Your organisation has reached its user limit, so your account could not be created. Contact your administrator.'));
        } else if (err === 'signup_failed') {
            setError(t('login.sso_signup_failed', 'Your account could not be created. Please try again or contact your administrator.'));
        }
    }, [t]);

    // Detect the invite-redeem failure redirect (?error=invite_expired /
    // invite_error). /auth/redeem-invite/:token 302s here, without the
    // token and without ever putting the person into signup mode, when the
    // token was unknown or expired, or when the lookup itself failed. Without
    // this, the visitor just sees a bare login page with no idea their
    // invitation did anything at all.
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const err = params.get('error');
        if (err === 'invite_expired') {
            setError(t('login.invite_link_expired', 'This invitation link has expired or is no longer valid. Ask whoever invited you for a new one.'));
            window.history.replaceState({}, '', window.location.pathname);
        } else if (err === 'invite_error') {
            setError(t('login.invite_link_error', 'Something went wrong opening this invitation. Please try the link again or ask for a new one.'));
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, [t]);
}
