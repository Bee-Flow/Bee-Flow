import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { TranslateFn } from '@/hooks/useTranslation';
import { API_BASE, authFetch } from '@/utils/helpers';
import type { AdminGroup, AdminMessage, AskConfirm, GroupFormData } from './types';
import { costLimitToInput, parseCostLimitInput } from './costLimitInput';

const EMPTY_GROUP: GroupFormData = {
    id: '', name: '', description: '', permissions: [], roles: [], organizationId: '', allowedAgentTypes: [], allowedTiers: [], orgRole: '', perUserCostLimit: '',
};

function groupToForm(group: AdminGroup): GroupFormData {
    return {
        id: group.id,
        name: group.name || '',
        description: group.description || '',
        permissions: group.permissions || [],
        roles: group.roles || [],
        organizationId: group.organizationId || '',
        allowedAgentTypes: group.allowedAgentTypes || [],
        allowedTiers: group.allowedTiers || [],
        orgRole: group.orgRole || '',
        perUserCostLimit: costLimitToInput(group.perUserCostLimit),
    };
}

/**
 * The request body: the form, with the budget as a number (self-hosted) or left out.
 * An unusable budget text is reported in the status line and gives null.
 */
function requestBody(form: GroupFormData, isSelfHosted: boolean, setMessage: Dispatch<SetStateAction<AdminMessage | null>>, t: TranslateFn, editing: boolean) {
    // Creating takes neither the inherited role nor the tiers, and updating takes neither the id nor the name.
    const { perUserCostLimit: typed, allowedTiers, orgRole, id: _id, name, ...common } = form;
    const rest = editing ? { ...common, allowedTiers: allowedTiers ?? [], orgRole: orgRole ?? '' } : { ...common, name };
    if (!isSelfHosted) return rest;
    const parsed = parseCostLimitInput(typed);
    if (parsed !== undefined) return { ...rest, perUserCostLimit: parsed };
    setMessage({ type: 'error', text: t('admin_org.cost_limit_invalid', 'Enter a budget above zero, or leave the field empty.') });
    return null;
}

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
    /** The per-member AI budget only exists on a self-hosted server. */
    isSelfHosted?: boolean;
}

export default function useGroupActions({ loadData, setMessage, askConfirm, t, isSelfHosted = false }: UseGroupActionsOptions): GroupActions {
    const [showAddGroup, setShowAddGroup] = useState(false);
    const [showEditGroup, setShowEditGroup] = useState(false);
    const [groupData, setGroupData] = useState<GroupFormData>(EMPTY_GROUP);

    const closeGroupModal = () => { setShowAddGroup(false); setShowEditGroup(false); };

    const openAddGroup = () => {
        setGroupData(EMPTY_GROUP);
        setShowAddGroup(true);
    };

    const openEditGroup = (group: AdminGroup) => {
        setGroupData(groupToForm(group));
        setShowEditGroup(true);
    };

    const handleAddGroup = async () => {
        if (!groupData.name) return;
        const body = requestBody(groupData, isSelfHosted, setMessage, t, false);
        if (!body) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/groups`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
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
        const body = requestBody(groupData, isSelfHosted, setMessage, t, true);
        if (!body) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupData.id}`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
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
