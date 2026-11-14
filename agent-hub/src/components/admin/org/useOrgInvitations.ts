import { useState } from 'react';
import { useOrgInvitationsQuery } from '@/api/queries/orgAdminReads';
import { useAdminOrgScope, withOrgIdParam } from '@/api/adminOrgScope';
import type { Dispatch, SetStateAction } from 'react';
import { ApiError, RefusedError, errorBody } from '@/api/mutate';
import { apiRequest } from '@/api/typedRequest';

/** One pending invitation, as GET /auth/invitations returns it. */
export interface Invitation {
    id: string;
    email?: string;
    role?: string;
    status?: string;
    inviterName?: string | null;
    expires_at?: string;
    [key: string]: unknown;
}

/**
 * The whole outcome of one invite. `inviteUrl` is only set when the mail did
 * NOT go out — it is the link to hand over instead — and `upgradeLink` marks
 * the seat cap, which is a route to the upgrade flow rather than a dead end.
 */
interface InviteResult {
    success: boolean;
    message: string;
    inviteUrl?: string | null;
    upgradeLink?: boolean;
}

export interface OrgInvitations {
    showInviteForm: boolean;
    setShowInviteForm: Dispatch<SetStateAction<boolean>>;
    inviteEmail: string;
    setInviteEmail: Dispatch<SetStateAction<string>>;
    inviteRole: string;
    setInviteRole: Dispatch<SetStateAction<string>>;
    sendingInvite: boolean;
    inviteResult: InviteResult | null;
    setInviteResult: Dispatch<SetStateAction<InviteResult | null>>;
    invitations: Invitation[];
    loadingInvitations: boolean;
    fetchInvitations: () => Promise<void>;
    handleSendInvite: () => Promise<void>;
    handleRevokeInvite: (invitationId: string) => Promise<void>;
}

/**
 * Inviting someone who has no account yet, and the pending invitations that
 * result. `inviteResult` carries the whole outcome — including the link to
 * share by hand when the mail could not be delivered, and the seat-cap flag
 * that sends an admin to the upgrade flow instead of a dead end. They are the
 * invitations of the organisation an AdminOrgScopeProvider names (the
 * dashboard's choice), else of the caller's own.
 */
const NO_INVITATIONS: Invitation[] = [];

/** The invitations read for the organisation an AdminOrgScopeProvider names (null: the caller's own). */
function useScopedInvitations() {
    const orgId = useAdminOrgScope();
    return { orgId, invitationsQuery: useOrgInvitationsQuery<Invitation>(orgId) };
}

export default function useOrgInvitations(): OrgInvitations {
    // Invitation state
    const [showInviteForm, setShowInviteForm] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState('user');
    const [sendingInvite, setSendingInvite] = useState(false);
    const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);

    const { orgId, invitationsQuery } = useScopedInvitations();
    const invitations = invitationsQuery.data ?? NO_INVITATIONS;
    const loadingInvitations = invitationsQuery.isFetching;
    const fetchInvitations = async () => { await invitationsQuery.refetch(); };

    // Invitation handlers
    const handleSendInvite = async () => {
        if (!inviteEmail.trim()) return;
        setSendingInvite(true);
        setInviteResult(null);
        try {
            let ok = true;
            let data: {
                success?: boolean; error?: string; code?: string;
                emailSent?: boolean; inviteUrl?: string;
            };
            try {
                const res = await apiRequest('POST /auth/invitations', {
                    query: { orgId: orgId || undefined },
                    body: { email: inviteEmail.trim(), role: inviteRole },
                });
                data = await res.json();
            } catch (err) {
                // A refusal carries its JSON body (error, code); a body that is not JSON is the network-error path.
                if (!(err instanceof RefusedError)) throw err;
                const body = errorBody(err);
                if (body == null) throw err;
                ok = false;
                data = body;
            }
            if (ok && data.success) {
                setInviteResult({
                    success: true,
                    message: data.emailSent ? `Invitation sent to ${inviteEmail}` : `Invitation created but email delivery failed. Share the link manually:`,
                    inviteUrl: !data.emailSent ? data.inviteUrl : null,
                });
                setInviteEmail('');
                setInviteRole('user');
                await fetchInvitations();
            } else {
                setInviteResult({
                    success: false,
                    message: data.error || 'Failed to send invitation',
                    // BFSF-251: seat cap reached → point the admin straight at
                    // the upgrade flow instead of a dead-end error.
                    upgradeLink: data.code === 'seat_cap_exceeded',
                });
            }
        } catch {
            setInviteResult({ success: false, message: 'Network error — please try again' });
        } finally {
            setSendingInvite(false);
        }
    };

    const handleRevokeInvite = async (invitationId: string) => {
        try {
            const res = await apiRequest('DELETE /auth/invitations/{id}', { params: { id: invitationId }, query: { orgId: orgId || undefined } }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) await fetchInvitations();
        } catch (err) {
            console.error('Failed to revoke invitation:', err);
        }
    };

    return {
        showInviteForm, setShowInviteForm,
        inviteEmail, setInviteEmail,
        inviteRole, setInviteRole,
        sendingInvite,
        inviteResult, setInviteResult,
        invitations,
        loadingInvitations,
        fetchInvitations,
        handleSendInvite,
        handleRevokeInvite,
    };
}
