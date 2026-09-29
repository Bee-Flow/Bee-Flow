import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import type { AdminGroup, AdminMessage, AskConfirm, GroupFormData } from './types';

const EMPTY_GROUP: GroupFormData = {
    id: '', name: '', description: '', permissions: [], roles: [], organizationId: '', allowedAgentTypes: [],
};

export interface GroupActions {
    groupData: GroupFormData;
    setGroupData: Dispatch<SetStateAction<GroupFormData>>;
    showAddGroup: boolean;
    showEditGroup: boolean;
    openAddGroup: () => void;
    openEditGroup: (group: AdminGroup) => void;
    closeGroupModal: () => void;
    handleAddGroup: () => Promise<void>;
    handleUpdateGroup: () => Promise<void>;
    handleDeleteGroup: (groupId: string) => void;
}

export interface UseGroupActionsOptions {
    loadData: () => Promise<void>;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    askConfirm: AskConfirm;
    t: TranslateFn;
}

export default function useGroupActions({ loadData, setMessage, askConfirm, t }: UseGroupActionsOptions): GroupActions {
    const [showAddGroup, setShowAddGroup] = useState(false);
    const [showEditGroup, setShowEditGroup] = useState(false);
    const [groupData, setGroupData] = useState<GroupFormData>(EMPTY_GROUP);

    const closeGroupModal = () => { setShowAddGroup(false); setShowEditGroup(false); };

    const openAddGroup = () => {
        setGroupData(EMPTY_GROUP);
        setShowAddGroup(true);
    };

    const openEditGroup = (group: AdminGroup) => {
        setGroupData({
            id: group.id,
            name: group.name || '',
            description: group.description || '',
            permissions: group.permissions || [],
            roles: group.roles || [],
            organizationId: group.organizationId || '',
            allowedAgentTypes: group.allowedAgentTypes || [],
        });
        setShowEditGroup(true);
    };

    const handleAddGroup = async () => {
        if (!groupData.name) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/groups`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(groupData),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Group created successfully' });
                setShowAddGroup(false);
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to create group' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleUpdateGroup = async () => {
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupData.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(groupData),
            });
            if (res.ok) {
                setMessage({ type: 'success', text: 'Group updated successfully' });
                setShowEditGroup(false);
                loadData();
            } else {
                const data = await res.json();
                setMessage({ type: 'error', text: data.error || 'Failed to update group' });
            }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    const handleDeleteGroup = (groupId: string) => {
        askConfirm({
            title: t('admin.sec_delete_group_title', 'Delete this group?'),
            description: t('admin.sec_delete_group_desc', 'Members keep their accounts but lose whatever this group granted them.'),
            confirmLabel: t('admin.sec_delete', 'Delete'),
            destructive: true,
            onConfirm: () => doDeleteGroup(groupId),
        });
    };

    const doDeleteGroup = async (groupId: string) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}`, { method: 'DELETE' });
            if (res.ok) { setMessage({ type: 'success', text: 'Group deleted' }); loadData(); }
            else { const d = await res.json(); setMessage({ type: 'error', text: d.error || 'Failed' }); }
        } catch (err) { setMessage({ type: 'error', text: 'Connection error' }); }
    };

    return {
        groupData, setGroupData,
        showAddGroup, showEditGroup,
        openAddGroup, openEditGroup, closeGroupModal,
        handleAddGroup, handleUpdateGroup, handleDeleteGroup,
    };
}
