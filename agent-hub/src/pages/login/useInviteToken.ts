import { useEffect, useState } from 'react';
import { useInviteLookupQuery, type InviteAnswer } from '../../api/queries/inviteRead';
import type { Setter, StateSetter } from './loginShared';
import type { SignupData } from './signupValidation';

/** What the invite endpoints answer about a token. */
export type InviteInfo = InviteAnswer;

interface InviteDeps {
    setInviteToken: Setter<string | null>;
    setInviteInfo: Setter<InviteInfo | null>;
    setSignupData: StateSetter<SignupData>;
    setSignupMode: Setter<boolean>;
    setError: Setter<string>;
}

/**
 * Detect and validate an invite token. Two paths:
 *   1. Legacy `?invite=TOKEN` query param (kept for backwards-compat).
 *   2. New flow: token lives in the server session after the user clicked
 *      the email link, which 302-redirected through /api/auth/redeem-invite/<token>.
 *      Pull it via /auth/pending-invite. No token ever appears in the URL bar.
 * The lookup is a query (api/queries/inviteRead.ts); its answer fills the signup form.
 */
export function useInviteToken({ setInviteToken, setInviteInfo, setSignupData, setSignupMode, setError }: InviteDeps): void {
    const [queryToken] = useState(() => new URLSearchParams(window.location.search).get('invite'));
    useEffect(() => {
        // Strip the token from the URL immediately so a copy/paste of the
        // address bar can't leak it.
        if (queryToken) window.history.replaceState({}, '', window.location.pathname);
    }, [queryToken]);

    const { data: lookup, error } = useInviteLookupQuery(queryToken);

    useEffect(() => {
        if (error) {
            console.error('Failed to validate invite:', error);
            setError('Failed to validate invitation. Please try again.');
            setInviteToken(null);
            return;
        }
        if (!lookup || lookup.kind === 'none') return;
        if (lookup.kind === 'invalid') {
            setError('This invitation link has expired or is no longer valid.');
            setInviteToken(null);
            return;
        }
        const { token, info } = lookup;
        setInviteToken(token);
        setInviteInfo(info);
        setSignupData(prev => ({
            ...prev,
            signupType: 'existing',
            organizationId: info.organizationId,
            // Carry the org's name from the invite. The public organisation
            // directory does not answer anonymously on cloud, so the invite is
            // the only place this name comes from.
            orgName: info.orgName || prev.orgName || '',
            email: info.email || prev.email,
        }));
        setSignupMode(true);
    }, [lookup, error, setError, setInviteInfo, setInviteToken, setSignupData, setSignupMode]);
}
