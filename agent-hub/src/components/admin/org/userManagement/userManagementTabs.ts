// The tabs of the users screen (UserManagement): which ones a viewer may open,
// and where each one lives in the admin dashboard (its address and its scope).
// Split out of UserManagement, which renders them.

import { Building, Cloud, Key, Layers, RefreshCw, Send, Shield, Tag, Users, UserCog } from 'lucide-react';
import type { ComponentType } from 'react';
import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import { OrgIcon } from './EntityRows';

/**
 * Where each tab of this screen lives in the admin dashboard: the address its
 * tab opens, and the dashboard tab and section whose scope it has (adminTabs).
 * The organisation's people are the People tab; the server-wide lists and the
 * organisation's own settings are rows of their own.
 */
export const TAB_HOMES: Readonly<Record<string, { tab: string; section?: string; path: string }>> = {
    users: { tab: 'people', section: 'users', path: 'admin/people/users' },
    invitations: { tab: 'people', section: 'invitations', path: 'admin/people/invitations' },
    groups: { tab: 'people', section: 'groups', path: 'admin/people/groups' },
    'org-roles': { tab: 'people', section: 'org-roles', path: 'admin/people/org-roles' },
    organizations: { tab: 'organisations', path: 'admin/organisations' },
    nextcloud: { tab: 'nextcloud-instances', path: 'admin/nextcloud-instances' },
    roles: { tab: 'roles', path: 'admin/roles' },
    permissions: { tab: 'roles', section: 'permissions', path: 'admin/roles/permissions' },
    'custom-tiers': { tab: 'organisation', section: 'models', path: 'admin/organisation/models' },
    sync: { tab: 'organisation', section: 'nextcloud-sync', path: 'admin/organisation/nextcloud-sync' },
    'my-organization': { tab: 'organisation', section: 'info', path: 'admin/organisation/info' },
};

/** The dashboard scope of a tab of this screen. */
export const tabScope = (key: string) => {
    const home = Object.hasOwn(TAB_HOMES, key) ? TAB_HOMES[key] : TAB_HOMES.users;
    return adminSectionScope(home.tab, home.section);
};

/** Is this tab of the screen about the whole server? */
export const isServerWideTab = (key: string) => tabScope(key) === 'instance';

/**
 * The section tabs this person may open: everything for a platform admin,
 * users/groups (and their own organisation) otherwise. The 'all' permission
 * is not enough: its holder's lists cover their own organisation only, and
 * the server-wide role table is not read for them.
 */
export interface SectionDef {
    key: string;
    labelKey: string;
    /** English text for a label whose key is not in the generated dictionary yet. */
    fallback?: string;
    icon: ComponentType<{ className?: string }>;
}

export function sectionsFor(isPlatformAdmin: boolean | undefined, hasOrg: boolean, mayManage: boolean, hasNcSync: boolean): SectionDef[] {
    // The organisation-only tabs, in the order Settings > Organisation > Users & Groups had them.
    const orgTabs = [
        ...(mayManage ? [{ key: 'invitations', labelKey: 'admin_org.users_tab_invitations', fallback: 'Invitations', icon: Send }] : []),
        { key: 'groups', labelKey: 'admin.users_tab_groups', icon: Shield },
        { key: 'org-roles', labelKey: 'admin_org.users_tab_org_roles', fallback: 'Organisation roles', icon: UserCog },
        ...(mayManage ? [{ key: 'custom-tiers', labelKey: 'admin_org.users_tab_custom_tiers', fallback: 'Model tiers', icon: Layers }] : []),
        ...(hasNcSync ? [{ key: 'sync', labelKey: 'admin_org.users_tab_nc_sync', fallback: 'Nextcloud sync', icon: RefreshCw }] : []),
    ];
    return isPlatformAdmin ? [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        { key: 'organizations', labelKey: 'admin.users_tab_organizations', icon: OrgIcon },
        { key: 'nextcloud', labelKey: 'admin.users_tab_nextcloud', icon: Cloud },
        ...orgTabs,
        { key: 'roles', labelKey: 'admin_org.users_tab_server_roles', fallback: 'Server roles', icon: Tag },
        { key: 'permissions', labelKey: 'admin.users_tab_permissions', icon: Key },
    ] : [
        { key: 'users', labelKey: 'admin.users_tab_users', icon: Users },
        ...orgTabs,
        ...(hasOrg ? [{ key: 'my-organization', labelKey: 'admin.users_tab_my_org', icon: Building }] : []),
    ];
}
