import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';

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
export interface InviteResult {
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
 * that sends an admin to the upgrade flow instead of a dead end.
 */
export default function useOrgInvitations(): OrgInvitations {
    // Invitation state
    const [showInviteForm, setShowInviteForm] = useState(false);
    const [inviteEmail, setInviteEmail] = useState('');
    const [inviteRole, setInviteRole] = useState('user');
    const [sendingInvite, setSendingInvite] = useState(false);
    const [inviteResult, setInviteResult] = useState<InviteResult | null>(null);
    const [invitations, setInvitations] = useState<Invitation[]>([]);
    const [loadingInvitations, setLoadingInvitations] = useState(false);

    // Fetch invitations
    const fetchInvitations = useCallback(async () => {
        setLoadingInvitations(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/invitations`);
            if (res.ok) setInvitations(await res.json());
        } catch (err) {
            console.error('Failed to fetch invitations:', err);
        } finally {
            setLoadingInvitations(false);
        }
    }, []);

    useEffect(() => { fetchInvitations(); }, [fetchInvitations]);

    // Invitation handlers
    const handleSendInvite = async () => {
        if (!inviteEmail.trim()) return;
        setSendingInvite(true);
        setInviteResult(null);
        try {
            const res = await authFetch(`${API_BASE}/auth/invitations`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
            });
            const data: {
                success?: boolean; error?: string; code?: string;
                emailSent?: boolean; inviteUrl?: string;
            } = await res.json();
            if (res.ok && data.success) {
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
            const res = await authFetch(`${API_BASE}/auth/invitations/${invitationId}`, { method: 'DELETE' });
            if (res.ok) await fetchInvitations();
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
