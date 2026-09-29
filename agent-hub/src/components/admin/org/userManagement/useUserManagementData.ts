import { useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import type { AdminGroup, AdminMessage, AdminOrganization, AdminPermission, AdminRole, AdminUser } from './types';

export interface UserManagementData {
    users: AdminUser[];
    groups: AdminGroup[];
    organizations: AdminOrganization[];
    roles: AdminRole[];
    permissions: AdminPermission[];
    loading: boolean;
    message: AdminMessage | null;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    loadData: () => Promise<void>;
}

/**
 * The platform console's directory: every user, group, role, permission and
 * organisation, across every tenant. One fetch feeds every tab; every
 * mutation in the other hooks of this screen ends by calling `loadData`
 * again so the tabs cannot disagree about the same rows.
 */
export default function useUserManagementData(): UserManagementData {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
    const [roles, setRoles] = useState<AdminRole[]>([]);
    const [permissions, setPermissions] = useState<AdminPermission[]>([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<AdminMessage | null>(null);

    const loadData = async () => {
        setLoading(true);
        try {
            const [usersRes, groupsRes, rolesRes, permsRes, orgsRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/users`),
                authFetch(`${API_BASE}/auth/groups`),
                authFetch(`${API_BASE}/auth/roles`),
                authFetch(`${API_BASE}/auth/permissions`),
                authFetch(`${API_BASE}/auth/organizations`),
            ]);

            if (usersRes.ok) setUsers(await usersRes.json());
            if (groupsRes.ok) setGroups(await groupsRes.json());
            if (rolesRes.ok) setRoles(await rolesRes.json());
            if (permsRes.ok) setPermissions(await permsRes.json());
            if (orgsRes.ok) setOrganizations(await orgsRes.json());
        } catch (err) {
            setMessage({ type: 'error', text: 'Failed to load data. Ensure you are admin.' });
        } finally {
            setLoading(false);
        }
    };

    // Load data on mount
    useEffect(() => {
        loadData();
    }, []);

    return { users, groups, organizations, roles, permissions, loading, message, setMessage, loadData };
}
