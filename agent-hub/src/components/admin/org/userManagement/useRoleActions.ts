import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AdminMessage, AdminRole, AskConfirm, RoleFormData } from './types';
import { apiFetch } from '@/api/typedRequest';

const EMPTY_ROLE: RoleFormData = { id: '', name: '', description: '', permissions: [] };

export interface RoleActions {
    roleData: RoleFormData;
    setRoleData: Dispatch<SetStateAction<RoleFormData>>;
    showAddRole: boolean;
    showEditRole: boolean;
    openAddRole: () => void;
    openEditRole: (role: AdminRole) => void;
    closeRoleModal: () => void;
    handleAddRole: () => Promise<void>;
    handleUpdateRole: () => Promise<void>;
    handleDeleteRole: (roleId: string) => void;
}

export interface UseRoleActionsOptions {
    loadData: () => Promise<void>;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    askConfirm: AskConfirm;
    t: TranslateFn;
}

export default function useRoleActions({ loadData, setMessage, askConfirm, t }: UseRoleActionsOptions): RoleActions {
    const [showAddRole, setShowAddRole] = useState(false);
    const [showEditRole, setShowEditRole] = useState(false);
    const [roleData, setRoleData] = useState<RoleFormData>(EMPTY_ROLE);

    const closeRoleModal = () => { setShowAddRole(false); setShowEditRole(false); };

    const openAddRole = () => {
        setRoleData(EMPTY_ROLE);
        setShowAddRole(true);
    };

    const openEditRole = (role: AdminRole) => {
        setRoleData({ id: role.id, name: role.name || '', description: role.description || '', permissions: role.permissions || [] });
        setShowEditRole(true);
    };

    const handleAddRole = async () => {
        if (!roleData.name) return;
        try {
            const res = await apiFetch('POST /auth/roles', { body: roleData });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Role created successfully' });
                setShowAddRole(false);
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to create role' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleUpdateRole = async () => {
        try {
            const res = await apiFetch('PUT /auth/roles/{id}', { params: { id: roleData.id }, body: roleData });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Role updated successfully' });
                setShowEditRole(false);
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to update role' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleDeleteRole = (roleId: string) => {
        askConfirm({
            title: t('admin.sec_delete_role_title', 'Delete this role?'),
            description: t('admin.sec_delete_role_desc', 'Groups and users holding this role lose the permissions it granted.'),
            confirmLabel: t('admin.sec_delete', 'Delete'),
            destructive: true,
            onConfirm: () => doDeleteRole(roleId),
        });
    };

    const doDeleteRole = async (roleId: string) => {
        try {
            const res = await apiFetch('DELETE /auth/roles/{id}', { params: { id: roleId } });
            if (res.ok) { setMessage({ type: 'success', text: 'Role deleted' }); loadData(); }
            else { const d = await res.json(); setMessage({ type: 'error', text: d.error || 'Failed' }); }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    return {
        roleData, setRoleData,
        showAddRole, showEditRole,
        openAddRole, openEditRole, closeRoleModal,
        handleAddRole, handleUpdateRole, handleDeleteRole,
    };
}
