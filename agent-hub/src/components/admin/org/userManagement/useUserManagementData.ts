import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE } from '@/utils/helpers';
import { settled } from '@/api/settled';
import { isPlatformAdmin } from '@/utils/adminAccess';
import type { AdminCurrentUser, AdminGroup, AdminMessage, AdminOrganization, AdminPermission, AdminRole, AdminUser } from './types';

export interface UserManagementData {
    users: AdminUser[];
    groups: AdminGroup[];
    organizations: AdminOrganization[];
    roles: AdminRole[];
    permissions: AdminPermission[];
    loading: boolean;
    /**
     * The admin-scoped user list was refused (403): the viewer holds a
     * directory permission but administers no organisation of their own, and
     * the dashboard lists are for organisation admins and platform admins.
     */
    notOrgAdmin: boolean;
    message: AdminMessage | null;
    setMessage: Dispatch<SetStateAction<AdminMessage | null>>;
    loadData: () => Promise<void>;
}

export interface UserManagementDataOptions {
    /**
     * The signed-in user. When the options are given, the lists are asked for
     * the admin dashboard's organisation (`?scope=admin`: an organisation admin
     * gets their home organisation, a platform admin everything), and the
     * server-wide role table only for a platform admin.
     */
    currentUser?: AdminCurrentUser | null;
}

/**
 * The directory behind Admin > Security > Users: users, groups, roles, permissions
 * and organisations. One fetch feeds every tab; every mutation in the other
 * hooks of this screen ends by calling `loadData` again so the tabs cannot
 * disagree about the same rows.
 *
 * Without `options` it asks the unscoped lists and always the role table.
 * With `options` the lists carry `?scope=admin`, and the role table (it holds
 * every organisation's roles) is only asked for a platform admin; anyone else
 * gets an empty `roles`.
 */
export default function useUserManagementData(options?: UserManagementDataOptions): UserManagementData {
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [groups, setGroups] = useState<AdminGroup[]>([]);
    const [organizations, setOrganizations] = useState<AdminOrganization[]>([]);
    const [roles, setRoles] = useState<AdminRole[]>([]);
    const [permissions, setPermissions] = useState<AdminPermission[]>([]);
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState<AdminMessage | null>(null);
    const [notOrgAdmin, setNotOrgAdmin] = useState(false);

    const adminScoped = options !== undefined;
    const readsRoles = !adminScoped || isPlatformAdmin(options.currentUser);

    const loadData = useCallback(async () => {
        const scope = adminScoped ? '?scope=admin' : '';
        setLoading(true);
        try {
            const [usersRes, groupsRes, rolesRes, permsRes, orgsRes] = await Promise.all([
                settled(`${API_BASE}/auth/users${scope}`, undefined, 'empty'),
                settled(`${API_BASE}/auth/groups${scope}`, undefined, 'empty'),
                readsRoles ? settled(`${API_BASE}/auth/roles`, undefined, 'empty') : Promise.resolve(null),
                settled(`${API_BASE}/auth/permissions`, undefined, 'empty'),
                settled(`${API_BASE}/auth/organizations${scope}`, undefined, 'empty'),
            ]);

            if (usersRes.ok) setUsers(await usersRes.res.json());
            setNotOrgAdmin(adminScoped && !usersRes.ok && usersRes.status === 403);
            if (groupsRes.ok) setGroups(await groupsRes.res.json());
            if (rolesRes === null) setRoles([]);
            else if (rolesRes.ok) setRoles(await rolesRes.res.json());
            if (permsRes.ok) setPermissions(await permsRes.res.json());
            if (orgsRes.ok) setOrganizations(await orgsRes.res.json());
        } catch (err) {
            setMessage({ type: 'error', text: 'Failed to load data. Ensure you are admin.' });
        } finally {
            setLoading(false);
        }
    }, [adminScoped, readsRoles]);

    // Load data on mount, and again when the caller's platform-admin standing changes.
    useEffect(() => {
        loadData();
    }, [loadData]);

    return { users, groups, organizations, roles, permissions, loading, notOrgAdmin, message, setMessage, loadData };
}
