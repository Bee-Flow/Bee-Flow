import { useEffect } from 'react';
import { getInviteByToken, getPendingInvite } from '../../api/loginRequests';
import type { Setter, StateSetter } from './loginShared';
import type { SignupData } from './signupValidation';

/** What the invite endpoints answer about a token. */
export interface InviteInfo {
    valid?: boolean;
    token?: string;
    email?: string;
    organizationId: string;
    orgName?: string;
    role?: string;
}

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
 */
export function useInviteToken({ setInviteToken, setInviteInfo, setSignupData, setSignupMode, setError }: InviteDeps): void {
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const queryToken = params.get('invite');
        if (queryToken) {
            // Strip the token from the URL immediately so a copy/paste of the
            // address bar can't leak it.
            window.history.replaceState({}, '', window.location.pathname);
        }

        const applyInvite = (token: string, data: InviteInfo) => {
            setInviteToken(token);
            setInviteInfo(data);
            setSignupData(prev => ({
                ...prev,
                signupType: 'existing',
                organizationId: data.organizationId,
                // Carry the org's name from the invite. The public organisation
                // directory no longer answers anonymously on cloud (it was
                // disclosing the whole customer list), so the invite is now the
                // only place this name comes from.
                orgName: data.orgName || prev.orgName || '',
                email: data.email || prev.email,
            }));
            setSignupMode(true);
        };

        const run = async () => {
            try {
                // Prefer the server-side session entry (new flow).
                const pendingRes = await getPendingInvite();
                if (pendingRes.ok) {
                    const data: InviteInfo = await pendingRes.json();
                    if (data.valid && data.token) {
                        applyInvite(data.token, data);
                        return;
                    }
                }
                // Fallback to the legacy query-param flow.
                if (!queryToken) return;
                const res = await getInviteByToken(queryToken);
                if (res.ok) {
                    const data: InviteInfo = await res.json();
                    if (data.valid) {
                        applyInvite(queryToken, data);
                        return;
                    }
                }
                setError('This invitation link has expired or is no longer valid.');
                setInviteToken(null);
            } catch (err) {
                console.error('Failed to validate invite:', err);
                setError('Failed to validate invitation. Please try again.');
                setInviteToken(null);
            }
        };
        run();
    }, [setError, setInviteInfo, setInviteToken, setSignupData, setSignupMode]);
}
