/**
 * The invitation an OAuth signup carries: /auth/redeem-invite parks the token
 * on the pre-auth session (login/inviteRoutes.js), POST /auth/pending-signup
 * marks the signup as invited (login/signupIntakeRoutes.js), and the OAuth
 * callback claims it here (oauth/ssoUserProvisioning.js), the same way the
 * password signup does (login/signupRoutes.js): the invitation is for one
 * address, the provider's address must be that one, and the claim is taken
 * before the account exists and handed back when the signup does not finish.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface InvitationRow {
    id: string;
    email?: string;
    organization_id?: string;
    [key: string]: unknown;
}

interface InvitationStore {
    getInvitationByToken(token: string): Promise<InvitationRow | null>;
    markAccepted(token: string): Promise<boolean>;
    releaseClaim(invitationId: string): Promise<unknown>;
}

const store = () => nodeRequire('../../stores/invitationStore') as InvitationStore;

/** The token /auth/redeem-invite parked on the session (any session shape). */
const sessionToken = (session: object | null | undefined): string | null => {
    const token = (session as { pendingInviteToken?: unknown } | null | undefined)?.pendingInviteToken;
    return typeof token === 'string' && token ? token : null;
};

/** The pending invitation on this session, or null. */
export async function pendingInvitation(session: object | null | undefined): Promise<InvitationRow | null> {
    const token = sessionToken(session);
    if (!token) return null;
    return store().getInvitationByToken(token);
}

export type InviteClaim =
    | { inviteData: InvitationRow; inviteToken: string }
    | { error: 'invalid_invite' | 'invite_email_mismatch' | 'invite_used' };

/** Claim the session's invitation for the provider's address. */
export async function claimSessionInvite(session: object | null | undefined, email: string | null | undefined): Promise<InviteClaim> {
    const token = sessionToken(session);
    const inviteData = token ? await store().getInvitationByToken(token) : null;
    if (!token || !inviteData) return { error: 'invalid_invite' };
    if (!email || String(email).trim().toLowerCase() !== String(inviteData.email || '').toLowerCase()) {
        return { error: 'invite_email_mismatch' };
    }
    if (!(await store().markAccepted(token))) return { error: 'invite_used' };
    return { inviteData, inviteToken: token };
}

/** Hand a claim back when the account was not created after all. */
export async function releaseInvite(inviteData: InvitationRow | null | undefined): Promise<void> {
    if (!inviteData) return;
    await store().releaseClaim(inviteData.id);
}
