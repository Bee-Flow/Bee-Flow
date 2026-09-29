import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { toast } from '../../../shared/Toast';
import type { AdminMessage, AdminUser, AskConfirm, UserFormData } from './types';

const EMPTY_USER: UserFormData = {
    id: '', username: '', displayName: '', firstName: '', lastName: '', email: '', phone: '',
    avatar: '', avatarType: '', password: '', role: 'user', groups: [], organizationId: '', orgRole: '',
};

export interface UserActions {
    userData: UserFormData;
    setUserData: Dispatch<SetStateAction<UserFormData>>;
    showAddUser: boolean;
    showEditUser: boolean;
    showEmojiPicker: boolean;
    setShowEmojiPicker: Dispatch<SetStateAction<boolean>>;
    openAddUser: () => void;
    openEditUser: (user: AdminUser) => void;
    closeUserModal: () => void;
    handleAddUser: () => Promise<void>;
    handleUpdateUser: (extra?: Record<string, unknown>) => Promise<void>;
    handleResetMfa: (user: AdminUser) => void;
    handleDeleteUser: (userId: string) => void;
    handleAvatarUpload: (file: File) => Promise<void>;
    handleAvatarRemove: () => Promise<void>;
}

export interface UseUserActionsOptions {
    loadData: () => Promise<void>;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    askConfirm: AskConfirm;
    t: TranslateFn;
}

export default function useUserActions({ loadData, setMessage, askConfirm, t }: UseUserActionsOptions): UserActions {
    const [showAddUser, setShowAddUser] = useState(false);
    const [showEditUser, setShowEditUser] = useState(false);
    const [showEmojiPicker, setShowEmojiPicker] = useState(false);
    const [userData, setUserData] = useState<UserFormData>(EMPTY_USER);

    const closeUserModal = () => { setShowAddUser(false); setShowEditUser(false); };

    const openAddUser = () => {
        setUserData(EMPTY_USER);
        setShowEmojiPicker(false);
        setShowAddUser(true);
    };

    const openEditUser = (user: AdminUser) => {
        setUserData({
            id: user.id || user.username || '',
            username: user.username || '',
            displayName: user.displayName || '',
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            email: user.email || '',
            phone: user.phone || '',
            avatar: user.avatar || '',
            avatarType: user.avatarType || '',
            password: '',
            role: user.role || 'user',
            groups: user.groups || [],
            organizationId: user.organizationId || '',
            orgRole: user.orgRole || '',
        });
        setShowEmojiPicker(false);
        setShowEditUser(true);
    };

    const handleAddUser = async () => {
        if (!userData.username || !userData.displayName || !userData.password) {
            const missing = [];
            if (!userData.username) missing.push('username');
            if (!userData.displayName) missing.push('display name');
            if (!userData.password) missing.push('password');
            setMessage({ type: 'error', text: `Required: ${missing.join(', ')}` });
            return;
        }
        try {
            const res = await authFetch(`${API_BASE}/auth/users`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(userData),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'User created successfully' });
                setShowAddUser(false);
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to create user' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Connection error' });
        }
    };

    // `confirmSelfDemotion` is the server's opt-in for an admin stripping their
    // OWN organisation-admin rights. It is not busywork: the panel PUTs the whole
    // user row back, so a mis-set role dropdown used to remove the caller's own
    // access in one click with nothing to confirm and no way back (a pentest did
    // exactly that and left the tenant unrecoverable). The server answers 409
    // with the downgrade hint; we turn that into a real confirm and re-send.
    const handleUpdateUser = async (extra: Record<string, unknown> = {}) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userData.id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ...userData, ...extra }),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'User updated successfully' });
                setShowEditUser(false);
                loadData();
                return;
            }
            const data = await res.json();
            if (res.status === 409 && data.code === 'confirm_self_demotion') {
                askConfirm({
                    title: t('admin.sec_self_demote_title', 'Give up your admin rights?'),
                    description: data.hint?.message
                        || t('admin.sec_self_demote_desc', 'This removes your own administrator rights over this organisation. Another administrator would have to give them back.'),
                    confirmLabel: t('admin.sec_self_demote_confirm', 'Yes, step down'),
                    destructive: true,
                    onConfirm: () => handleUpdateUser({ confirmSelfDemotion: true }),
                });
                return;
            }
            setMessage({ type: 'error', text: data.error || 'Failed to update user' });
        } catch (err) {
            setMessage({ type: 'error', text: 'Connection error' });
        }
    };

    // BFSF-274: org-admin escape hatch for users locked out of 2FA. Clears the
    // enrollment; forced re-enrollment (when enabled) kicks in at next login.
    const handleResetMfa = (user: AdminUser) => {
        const name = user.displayName || user.username || user.id;
        askConfirm({
            title: t('admin.sec_reset_mfa_title', 'Reset two-factor authentication?'),
            description: t('admin.reset_mfa_confirm', 'Reset two-factor authentication for {name}? Their authenticator and recovery codes stop working immediately; they will be asked to enroll again at their next sign-in.', { name }),
            confirmLabel: t('admin.reset_mfa', 'Reset 2FA'),
            destructive: true,
            onConfirm: () => doResetMfa(user),
        });
    };

    const doResetMfa = async (user: AdminUser) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${user.id}/mfa/reset`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                toast.error(data.error || 'Failed to reset 2FA');
            } else if (data.wasEnabled === false) {
                toast.info(t('admin.reset_mfa_not_enabled', 'This user has no two-factor authentication enabled.'));
            } else {
                toast.success(t('admin.reset_mfa_done', 'Two-factor authentication was reset.'));
            }
        } catch (err) {
            console.error('Failed to reset 2FA:', err);
            toast.error('Failed to reset 2FA. Please try again.');
        }
    };

    const handleDeleteUser = (userId: string) => {
        askConfirm({
            title: t('admin.sec_delete_user_title', 'Delete this user?'),
            description: t('admin.sec_delete_user_desc', 'The account is removed and cannot be restored.'),
            confirmLabel: t('admin.sec_delete', 'Delete'),
            destructive: true,
            onConfirm: () => doDeleteUser(userId),
        });
    };

    const doDeleteUser = async (userId: string) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userId}`, { method: 'DELETE' });
            if (res.ok) {
                setMessage({ type: 'success', text: 'User deleted' });
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to delete user' });
            }
        } catch (err) {
            setMessage({ type: 'error', text: 'Connection error' });
        }
    };

    // Avatar picker writes: an edited user with an id uploads/deletes through
    // the server right away; a not-yet-created user only has a local preview,
    // read into the form as a data URL and sent along with the eventual POST.
    const handleAvatarUpload = async (file: File) => {
        if (showEditUser && userData.id) {
            const formData = new FormData();
            formData.append('avatar', file);
            try {
                const res = await authFetch(`${API_BASE}/auth/users/${userData.id}/avatar`, { method: 'POST', body: formData });
                if (res.ok) {
                    const data = await res.json();
                    setUserData(p => ({ ...p, avatar: data.avatar, avatarType: 'image' }));
                    setMessage({ type: 'success', text: 'Avatar uploaded' });
                }
            } catch (err) { setMessage({ type: 'error', text: 'Upload failed' }); }
        } else {
            const reader = new FileReader();
            reader.onload = (ev) => setUserData(p => ({ ...p, avatar: String(ev.target?.result || ''), avatarType: 'image' }));
            reader.readAsDataURL(file);
        }
        setShowEmojiPicker(false);
    };

    const handleAvatarRemove = async () => {
        if (showEditUser && userData.id && userData.avatarType === 'image') {
            await authFetch(`${API_BASE}/auth/users/${userData.id}/avatar`, { method: 'DELETE' });
        }
        setUserData(p => ({ ...p, avatar: '', avatarType: '' }));
        setShowEmojiPicker(false);
    };

    return {
        userData, setUserData,
        showAddUser, showEditUser,
        showEmojiPicker, setShowEmojiPicker,
        openAddUser, openEditUser, closeUserModal,
        handleAddUser, handleUpdateUser, handleResetMfa, handleDeleteUser,
        handleAvatarUpload, handleAvatarRemove,
    };
}
