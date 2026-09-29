import { useEffect, useRef, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { OrgMember, Organization } from './useOrgDirectory';
import { API_BASE, authFetch } from '../../../utils/helpers';
import { toast } from '../../shared/Toast';

export interface OrgGroups {
    showCreateGroup: boolean;
    setShowCreateGroup: Dispatch<SetStateAction<boolean>>;
    newGroupName: string;
    setNewGroupName: Dispatch<SetStateAction<string>>;
    newGroupDesc: string;
    setNewGroupDesc: Dispatch<SetStateAction<string>>;
    newGroupOrg: string;
    setNewGroupOrg: Dispatch<SetStateAction<string>>;
    creatingGroup: boolean;
    /** Id of the group whose description is being edited; null when none is. */
    editingGroup: string | null;
    setEditingGroup: Dispatch<SetStateAction<string | null>>;
    editGroupDesc: string;
    setEditGroupDesc: Dispatch<SetStateAction<string>>;
    expandedGroup: string | null;
    setExpandedGroup: Dispatch<SetStateAction<string | null>>;
    /** Id of the MEMBER whose group popover is open — it hangs off a user row. */
    groupAssignOpenFor: string | null;
    setGroupAssignOpenFor: Dispatch<SetStateAction<string | null>>;
    groupAssignSearch: string;
    setGroupAssignSearch: Dispatch<SetStateAction<string>>;
    groupAssignRef: RefObject<HTMLDivElement | null>;
    memberAddGroupId: string | null;
    setMemberAddGroupId: Dispatch<SetStateAction<string | null>>;
    memberAddSearch: string;
    setMemberAddSearch: Dispatch<SetStateAction<string>>;
    memberBusy: boolean;
    handleUpdateGroupAllowedTiers: (groupId: string, newAllowedTiers: string[]) => Promise<void>;
    handleCreateGroup: () => Promise<void>;
    handleDeleteGroup: (groupId: string) => Promise<void>;
    handleUpdateGroupDesc: (groupId: string) => Promise<void>;
    handleUpdateGroupRole: (groupId: string, newRole: string) => Promise<void>;
    handleUserGroupToggle: (userId: string, groupId: string, currentGroups: string[]) => Promise<void>;
    getGroupCount: (groupId: string) => number;
    getGroupMembers: (groupId: string) => OrgMember[];
    addGroupMember: (groupId: string, userId: string) => Promise<void>;
    removeGroupMember: (groupId: string, userId: string) => Promise<void>;
}

export interface UseOrgGroupsOptions {
    users: OrgMember[];
    organizations: Organization[];
    /** Re-read the whole directory — every write here ends in it. */
    fetchData: () => Promise<void> | void;
    confirm: (opts: {
        title: string;
        description?: string;
        confirmLabel?: string;
        destructive?: boolean;
    }) => Promise<boolean>;
}

/**
 * The Groups tab's own state and every write behind it: creating, renaming,
 * deleting, the role and the tiers a group grants, and membership from both
 * directions (a user's groups on the Users tab, a group's members here).
 *
 * Reads come in from useOrgDirectory and every write ends in its `fetchData`,
 * so the two tabs never show a different answer to the same question.
 */
export default function useOrgGroups({ users, organizations, fetchData, confirm }: UseOrgGroupsOptions): OrgGroups {
    // Group creation form
    const [showCreateGroup, setShowCreateGroup] = useState(false);
    const [newGroupName, setNewGroupName] = useState('');
    const [newGroupDesc, setNewGroupDesc] = useState('');
    const [newGroupOrg, setNewGroupOrg] = useState('');
    const [creatingGroup, setCreatingGroup] = useState(false);

    // Editing
    const [editingGroup, setEditingGroup] = useState<string | null>(null);
    const [editGroupDesc, setEditGroupDesc] = useState('');

    // Expanded group members
    const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

    // Group-assign popover (click-to-open replaces the old hover dropdown).
    const [groupAssignOpenFor, setGroupAssignOpenFor] = useState<string | null>(null);
    const [groupAssignSearch, setGroupAssignSearch] = useState('');
    const groupAssignRef = useRef<HTMLDivElement | null>(null);
    // BFSF-219: add/remove members directly from the group view (the reciprocal
    // of the user→group flow on the Users tab).
    const [memberAddGroupId, setMemberAddGroupId] = useState<string | null>(null);
    const [memberAddSearch, setMemberAddSearch] = useState('');
    const [memberBusy, setMemberBusy] = useState(false);

    // Close the group-assign popover on outside-click or Esc.
    useEffect(() => {
        if (!groupAssignOpenFor) return;
        const onDocClick = (e: MouseEvent) => {
            if (groupAssignRef.current && e.target instanceof Node && !groupAssignRef.current.contains(e.target)) {
                setGroupAssignOpenFor(null);
                setGroupAssignSearch('');
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setGroupAssignOpenFor(null); setGroupAssignSearch(''); } };
        document.addEventListener('mousedown', onDocClick);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDocClick);
            document.removeEventListener('keydown', onKey);
        };
    }, [groupAssignOpenFor]);

    useEffect(() => {
        if (!newGroupOrg && organizations.length > 0) {
            setNewGroupOrg(organizations[0].id);
        }
    }, [organizations, newGroupOrg]);

    const handleUpdateGroupAllowedTiers = async (groupId: string, newAllowedTiers: string[]) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ allowedTiers: newAllowedTiers }),
            });
            if (res.ok) {
                await fetchData();
            } else {
                const body: { error?: string } = await res.json().catch(() => ({}));
                console.error('Failed to update group allowedTiers:', res.status, body);
                toast.error(`Failed to update allowed tiers (${res.status}): ${body.error || 'unknown error'}`);
            }
        } catch (err) {
            console.error('Failed to update group allowedTiers:', err);
            toast.error(`Failed to update allowed tiers: ${err instanceof Error ? err.message : String(err)}`);
        }
    };

    const handleCreateGroup = async () => {
        if (!newGroupName.trim()) return;
        setCreatingGroup(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/groups`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: newGroupName.trim(),
                    description: newGroupDesc.trim(),
                    organizationId: newGroupOrg || null,
                }),
            });
            if (res.ok) {
                setNewGroupName('');
                setNewGroupDesc('');
                setShowCreateGroup(false);
                await fetchData();
            }
        } catch (err) {
            console.error('Failed to create group:', err);
        } finally {
            setCreatingGroup(false);
        }
    };

    const handleDeleteGroup = async (groupId: string) => {
        if (!(await confirm({ title: 'Delete this group?', description: 'Users will be unassigned.', confirmLabel: 'Delete', destructive: true }))) return;
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}`, { method: 'DELETE' });
            if (res.ok) await fetchData();
        } catch (err) {
            console.error('Failed to delete group:', err);
        }
    };

    const handleUpdateGroupDesc = async (groupId: string) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ description: editGroupDesc }),
            });
            if (res.ok) {
                setEditingGroup(null);
                await fetchData();
            }
        } catch (err) {
            console.error('Failed to update group:', err);
        }
    };

    const handleUpdateGroupRole = async (groupId: string, newRole: string) => {
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ orgRole: newRole }),
            });
            if (res.ok) {
                await fetchData();
            }
        } catch (err) {
            console.error('Failed to update group role:', err);
        }
    };

    const handleUserGroupToggle = async (userId: string, groupId: string, currentGroups: string[]) => {
        const updatedGroups = currentGroups.includes(groupId)
            ? currentGroups.filter(g => g !== groupId)
            : [...currentGroups, groupId];
        try {
            const res = await authFetch(`${API_BASE}/auth/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ groups: updatedGroups }),
            });
            if (res.ok) await fetchData();
        } catch (err) {
            console.error('Failed to update user groups:', err);
        }
    };

    const getGroupCount = (groupId: string) => {
        return users.filter(u => {
            const uGroups = Array.isArray(u.groups) ? u.groups : [];
            return uGroups.includes(groupId);
        }).length;
    };

    const getGroupMembers = (groupId: string) => {
        return users.filter(u => {
            const uGroups = Array.isArray(u.groups) ? u.groups : [];
            return uGroups.includes(groupId);
        });
    };

    const addGroupMember = async (groupId: string, userId: string) => {
        setMemberBusy(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}/members`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userId }),
            });
            if (!res.ok) { const e: { error?: string } = await res.json().catch(() => ({})); toast.error(e.error || 'Failed to add member'); }
            else { setMemberAddSearch(''); await fetchData(); }
        } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
        finally { setMemberBusy(false); }
    };

    const removeGroupMember = async (groupId: string, userId: string) => {
        setMemberBusy(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
            if (!res.ok) { const e: { error?: string } = await res.json().catch(() => ({})); toast.error(e.error || 'Failed to remove member'); }
            else { await fetchData(); }
        } catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
        finally { setMemberBusy(false); }
    };

    return {
        showCreateGroup, setShowCreateGroup,
        newGroupName, setNewGroupName,
        newGroupDesc, setNewGroupDesc,
        newGroupOrg, setNewGroupOrg,
        creatingGroup,
        editingGroup, setEditingGroup,
        editGroupDesc, setEditGroupDesc,
        expandedGroup, setExpandedGroup,
        groupAssignOpenFor, setGroupAssignOpenFor,
        groupAssignSearch, setGroupAssignSearch,
        groupAssignRef,
        memberAddGroupId, setMemberAddGroupId,
        memberAddSearch, setMemberAddSearch,
        memberBusy,
        handleUpdateGroupAllowedTiers,
        handleCreateGroup,
        handleDeleteGroup,
        handleUpdateGroupDesc,
        handleUpdateGroupRole,
        handleUserGroupToggle,
        getGroupCount,
        getGroupMembers,
        addGroupMember,
        removeGroupMember,
    };
}
