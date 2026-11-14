// The invite a signup may carry: the one in the server session (after the e-mail
// link went through /api/auth/redeem-invite/<token>), else the legacy `?invite=`
// token of the address. Asked once per mount.

import { useQuery } from '@tanstack/react-query';
import { getInviteByToken, getPendingInvite } from '../loginRequests';
import { READ_ONCE } from './readOnce';

/** What the invite endpoints answer about a token. */
export interface InviteAnswer {
    valid?: boolean;
    token?: string;
    email?: string;
    organizationId: string;
    orgName?: string;
    role?: string;
}

/** A valid invite with its token, `invalid` when the legacy token was refused, `none` when there is no invite at all. */
export type InviteLookup =
    | { kind: 'invite'; token: string; info: InviteAnswer }
    | { kind: 'invalid' }
    | { kind: 'none' };

async function lookUpInvite(queryToken: string | null): Promise<InviteLookup> {
    // Prefer the server-side session entry.
    const pendingRes = await getPendingInvite();
    if (pendingRes.ok) {
        const data: InviteAnswer = await pendingRes.json();
        if (data.valid && data.token) return { kind: 'invite', token: data.token, info: data };
    }
    if (!queryToken) return { kind: 'none' };
    const res = await getInviteByToken(queryToken);
    if (res.ok) {
        const data: InviteAnswer = await res.json();
        if (data.valid) return { kind: 'invite', token: queryToken, info: data };
    }
    return { kind: 'invalid' };
}

/** The invite lookup; a network failure is the query's error. */
export function useInviteLookupQuery(queryToken: string | null) {
    return useQuery<InviteLookup, Error>({
        queryKey: ['login', 'invite', queryToken],
        ...READ_ONCE,
        queryFn: () => lookUpInvite(queryToken),
    });
}
