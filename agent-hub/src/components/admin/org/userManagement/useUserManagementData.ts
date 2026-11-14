import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { settled } from '@/api/settled';
import { isPlatformAdmin } from '@/utils/adminAccess';
import type { AdminCurrentUser, AdminGroup, AdminMessage, AdminOrganization, AdminPermission, AdminRole, AdminUser } from './types';
import { apiUrl } from '@/api/typedRequest';

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
    /**
     * The organisation the admin dashboard shows (a platform admin's choice), sent
     * as `orgId` with the user and group lists; null or absent sends none. The
     * organisation list is the server-wide one and stays complete.
     */
    orgId?: string | null;
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
/** The five lists as one read; a refused list is `null`, so the caller keeps what it showed. */
interface DirectoryRead {
    users: AdminUser[] | null;
    groups: AdminGroup[] | null;
    roles: AdminRole[] | null;
    permissions: AdminPermission[] | null;
    organizations: AdminOrganization[] | null;
    notOrgAdmin: boolean;
}

const EMPTY: never[] = [];

async function readDirectory(adminScoped: boolean, readsRoles: boolean, orgId: string | null): Promise<DirectoryRead> {
    const scope = adminScoped ? '?scope=admin' : '';
    const memberScope = orgId ? `${scope}&orgId=${encodeURIComponent(orgId)}` : scope;
    const [usersRes, groupsRes, rolesRes, permsRes, orgsRes] = await Promise.all([
        settled(`${apiUrl('GET /auth/users')}${memberScope}`, undefined, 'empty'),
        settled(`${apiUrl('GET /auth/groups')}${memberScope}`, undefined, 'empty'),
        readsRoles ? settled(apiUrl('GET /auth/roles'), undefined, 'empty') : Promise.resolve(null),
        settled(apiUrl('GET /auth/permissions'), undefined, 'empty'),
        settled(`${apiUrl('GET /auth/organizations')}${scope}`, undefined, 'empty'),
    ]);
    return {
        users: usersRes.ok ? await usersRes.res.json() : null,
        notOrgAdmin: adminScoped && !usersRes.ok && usersRes.status === 403,
        groups: groupsRes.ok ? await groupsRes.res.json() : null,
        roles: rolesRes === null ? [] : (rolesRes.ok ? await rolesRes.res.json() : null),
        permissions: permsRes.ok ? await permsRes.res.json() : null,
        organizations: orgsRes.ok ? await orgsRes.res.json() : null,
    };
}

export default function useUserManagementData(options?: UserManagementDataOptions): UserManagementData {
    const [message, setMessage] = useState<AdminMessage | null>(null);

    const adminScoped = options !== undefined;
    const readsRoles = !adminScoped || isPlatformAdmin(options.currentUser);
    const orgId = adminScoped ? options.orgId ?? null : null;

    // Read on mount, and again when the caller's platform-admin standing or the chosen organisation changes.
    const query = useQuery<DirectoryRead>({
        queryKey: ['admin', 'userDirectory', { adminScoped, readsRoles, orgId }],
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                return await readDirectory(adminScoped, readsRoles, orgId);
            } catch (err) {
                setMessage({ type: 'error', text: 'Failed to load data. Ensure you are admin.' });
                throw err;
            }
        },
    });

    // A refused list keeps the rows the screen showed last, across a reload and a change of organisation.
    const [shown, setShown] = useState<Omit<DirectoryRead, 'notOrgAdmin'>>({ users: EMPTY, groups: EMPTY, roles: EMPTY, permissions: EMPTY, organizations: EMPTY });
    const [seen, setSeen] = useState<DirectoryRead | undefined>(undefined);
    if (query.data && query.data !== seen) {
        setSeen(query.data);
        const d = query.data;
        setShown((prev) => ({
            users: d.users ?? prev.users,
            groups: d.groups ?? prev.groups,
            roles: d.roles ?? prev.roles,
            permissions: d.permissions ?? prev.permissions,
            organizations: d.organizations ?? prev.organizations,
        }));
    }

    const { refetch } = query;
    const loadData = useCallback(async () => { await refetch(); }, [refetch]);

    return {
        users: shown.users ?? EMPTY,
        groups: shown.groups ?? EMPTY,
        organizations: shown.organizations ?? EMPTY,
        roles: shown.roles ?? EMPTY,
        permissions: shown.permissions ?? EMPTY,
        loading: query.isFetching,
        notOrgAdmin: query.data?.notOrgAdmin ?? false,
        message, setMessage, loadData,
    };
}
