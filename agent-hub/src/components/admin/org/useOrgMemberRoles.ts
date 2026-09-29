import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../utils/helpers';

/**
 * A role change the server refused with 'confirm_self_demotion': allowed, but
 * only deliberately, so it is re-sent with `confirmSelfDemotion` once the
 * member has read what they are giving up.
 */
export interface PendingSelfDemotion {
    userId: string;
    newRole: string;
    /** The server's own wording, when it sent one; the dialog has its own. */
    message?: string;
}

export interface OrgMemberRoles {
    /** Id of the member whose role dropdown is open; null when none is. */
    editingUserRole: string | null;
    setEditingUserRole: Dispatch<SetStateAction<string | null>>;
    /** A refused role change, in the member's own words. '' when there is none. */
    roleChangeError: string;
    setRoleChangeError: Dispatch<SetStateAction<string>>;
    pendingSelfDemotion: PendingSelfDemotion | null;
    setPendingSelfDemotion: Dispatch<SetStateAction<PendingSelfDemotion | null>>;
    handleUserRoleChange: (userId: string, newRole: string, opts?: Record<string, unknown>) => Promise<void>;
    handleApproveUser: (userId: string) => Promise<void>;
    handleRejectUser: (userId: string) => Promise<void>;
}

export interface UseOrgMemberRolesOptions {
    /** Re-read the whole directory, so every tab agrees again. */
    fetchData: () => Promise<void> | void;
    confirm: (opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        destructive?: boolean;
    }) => Promise<boolean>;
}

/**
 * Changing what a member may do, and letting someone in or turning them away.
 *
 * The server can REFUSE a role change, and both refusals are answered here:
 * 'last_org_admin' is reported, 'confirm_self_demotion' is confirmed and
 * re-sent. Silence was the old answer to both.
 */
export default function useOrgMemberRoles({ fetchData, confirm }: UseOrgMemberRolesOptions): OrgMemberRoles {
    const { t } = useTranslation();
    // User role editing
    const [editingUserRole, setEditingUserRole] = useState<string | null>(null);
    // A refused role change now says so instead of silently doing nothing.
    const [roleChangeError, setRoleChangeError] = useState('');
    const [pendingSelfDemotion, setPendingSelfDemotion] = useState<PendingSelfDemotion | null>(null);

    // A role change can now be REFUSED by the server, and silence was the wrong
    // answer to that: this used to check `res.ok` and, when it was false, simply
    // leave the dropdown showing the role it had failed to set. Two refusals are
    // possible — 'last_org_admin' (the change would leave the organisation with
    // no administrator at all, which nothing in the app could undo) and
    // 'confirm_self_demotion' (you are giving up your own admin rights, which is
    // allowed but must be deliberate). The first is reported; the second is
    // confirmed and re-sent.
    const handleUserRoleChange = async (userId: string, newRole: string, opts: Record<string, unknown> = {}) => {
        setRoleChangeError('');
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orgRole: newRole, ...opts }),
            });
            if (res.ok) {
                setEditingUserRole(null);
                setPendingSelfDemotion(null);
                await fetchData();
                return;
            }
            const data: {
                code?: string; error?: string; hint?: { message?: string };
            } = await res.json().catch(() => ({}));
            if (res.status === 409 && data.code === 'confirm_self_demotion') {
                setPendingSelfDemotion({ userId, newRole, message: data.hint?.message || data.error });
                return;
            }
            setRoleChangeError(data.error || t('admin.role_change_failed', 'That role change could not be applied.'));
        } catch (err) {
            console.error('Failed to update user role:', err);
            setRoleChangeError(t('admin.role_change_failed', 'That role change could not be applied.'));
        }
    };

    const handleApproveUser = async (userId: string) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'active', orgRole: 'user' }),
            });
            if (res.ok) await fetchData();
        } catch (err) {
            console.error('Failed to approve user:', err);
        }
    };

    const handleRejectUser = async (userId: string) => {
        if (!(await confirm({ title: 'Reject and remove this user?', description: 'They can sign up again later.', confirmLabel: 'Reject', destructive: true }))) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userId}`, { method: 'DELETE' });
            if (res.ok) await fetchData();
        } catch (err) {
            console.error('Failed to reject user:', err);
        }
    };

    return {
        editingUserRole, setEditingUserRole,
        roleChangeError, setRoleChangeError,
        pendingSelfDemotion, setPendingSelfDemotion,
        handleUserRoleChange,
        handleApproveUser,
        handleRejectUser,
    };
}
