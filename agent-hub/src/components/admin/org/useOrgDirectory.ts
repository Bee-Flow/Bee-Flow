import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { settled } from '@/api/settled';
import { useDeploymentMode } from '@/hooks/useDeploymentMode';
import useCustomTiersMeta from './useCustomTiersMeta';
import { apiUrl } from '@/api/typedRequest';
import type { ImageLimits } from '@/utils/imageLimits';

/**
 * One member, as GET /auth/users returns them. Only what the panel reads is
 * named; the row carries more and the server owns it.
 */
export interface OrgMember {
    id: string;
    email?: string;
    username?: string;
    displayName?: string;
    avatar?: string | null;
    avatarType?: string | null;
    role?: string;
    orgRole?: string;
    status?: string;
    organizationId?: string | null;
    /** Group ids, not group rows. */
    groups?: string[];
    isSystem?: boolean;
    /** Self-hosted monthly AI budget in euro; null/absent = none. */
    monthlyCostLimit?: number | null;
    /** The member's own image limits per window; null/absent = none set. */
    imageLimits?: ImageLimits | null;
    [key: string]: unknown;
}

/** One group, as GET /auth/groups returns it. */
export interface OrgGroupRow {
    id: string;
    name?: string;
    description?: string;
    organizationId?: string | null;
    orgRole?: string;
    /** Empty = no restriction; non-empty = only these tier ids. */
    allowedTiers?: string[];
    /** Self-hosted AI budget per member per month in euro; null/absent = none. */
    perUserCostLimit?: number | null;
    /** The image limits EACH member gets per window; null/absent = none set. */
    perUserImageLimits?: ImageLimits | null;
    source?: string;
    lastSyncedAt?: string | null;
    [key: string]: unknown;
}

export interface Organization {
    id: string;
    name?: string;
    /** 'password' | an external provider; only the latter can auto-approve. */
    authMethod?: string | null;
    autoApproveSSO?: boolean;
    [key: string]: unknown;
}

/** What one org role grants, as GET /auth/org-roles returns it. */
export interface OrgRolePermissions {
    id: string;
    permissions: string[];
}

/** A custom tier's pill: id, plus whatever it is labelled with. */
export interface CustomTierMeta {
    id: string;
    label?: string;
    icon?: string;
    description?: string;
    [key: string]: unknown;
}

/** One member's AI spend over the last 30 days. */
export interface MemberUsage {
    calls: number;
    cost: number;
}

export interface OrgDirectory {
    users: OrgMember[];
    groups: OrgGroupRow[];
    orgRolePerms: OrgRolePermissions[];
    setOrgRolePerms: Dispatch<SetStateAction<OrgRolePermissions[]>>;
    editablePermissions: string[];
    organizations: Organization[];
    loading: boolean;
    /**
     * The admin-scoped member list was refused (403): the viewer administers
     * no organisation of their own, as the admin dashboard tells the same case.
     */
    notOrgAdmin: boolean;
    customTiersMeta: CustomTierMeta[];
    usageByUser: Map<string, MemberUsage>;
    /** null until the org row lands, and for an org that has no sign-in method. */
    orgAuthMethod: string | null;
    autoApprove: boolean;
    savingAutoApprove: boolean;
    myOrgId: string | null;
    fetchData: () => Promise<void>;
    handleToggleAutoApprove: () => Promise<void>;
}

export interface UseOrgDirectoryOptions {
    user?: { organizationId?: string | null } | null;
}

/** The four lists as one read; a list that was refused is null, so the panel keeps what it showed. */
interface DirectoryRead {
    users: OrgMember[] | null;
    notOrgAdmin: boolean;
    groups: OrgGroupRow[] | null;
    orgRoles: { roles?: OrgRolePermissions[]; editablePermissions?: string[] } | null;
    organizations: Organization[] | null;
}

/**
 * /auth/roles (the install-wide SYSTEM role table) is not read here: the panel
 * is about ORG roles. The three lists are the admin dashboard's
 * (`?scope=admin`): the viewer's home organisation, the one its writes are
 * accepted for (every organisation for a platform admin).
 */
async function readOrgDirectory(): Promise<DirectoryRead> {
    const [usersRes, groupsRes, orgsRes, orgRolesRes] = await Promise.all([
        settled(apiUrl('GET /auth/users', { query: { scope: 'admin' } }), undefined, 'empty'),
        settled(apiUrl('GET /auth/groups', { query: { scope: 'admin' } }), undefined, 'empty'),
        settled(apiUrl('GET /auth/organizations', { query: { scope: 'admin' } }), undefined, 'empty'),
        settled(apiUrl('GET /auth/org-roles'), undefined, 'empty'),
    ]);
    return {
        users: usersRes.ok ? await usersRes.res.json() : null,
        notOrgAdmin: !usersRes.ok && usersRes.status === 403,
        groups: groupsRes.ok ? await groupsRes.res.json() : null,
        orgRoles: orgRolesRes.ok ? ((await orgRolesRes.res.json()) ?? {}) : null,
        organizations: orgsRes.ok ? await orgsRes.res.json() : null,
    };
}

/**
 * Self-hosted reads the calendar month, the period the monthly AI budget is
 * enforced on (core/entitlements/selfHostedBudget.mts), so the figure next to a
 * member's budget is the one the limit compares against; cloud keeps the last
 * 30 days. A refusal rejects (the panel keeps what it showed).
 */
async function readUsageByUser(isSelfHosted: boolean): Promise<Map<string, MemberUsage>> {
    const now = new Date();
    const query = isSelfHosted
        ? { startDate: new Date(now.getFullYear(), now.getMonth(), 1).toISOString(), endDate: now.toISOString() }
        : { days: 30 };
    const res = await settled(apiUrl('GET /api/usage/by-user', { query }), undefined, 'empty');
    if (!res.ok) throw new UsageRefused(res.status);
    const rows: Array<{ user_id: string; calls?: unknown; estimated_cost?: unknown }> = await res.res.json();
    const map = new Map<string, MemberUsage>();
    for (const r of rows) {
        map.set(r.user_id, {
            calls: Number(r.calls) || 0,
            cost: Number(r.estimated_cost) || 0,
        });
    }
    return map;
}

const NO_USAGE = new Map<string, MemberUsage>();

/** A refused usage read: kept quiet, like an install without the usage routes. */
class UsageRefused extends Error {
    constructor(status: number) { super(`usage ${status}`); }
}

/**
 * What the organisation IS: its members, its groups, the permissions its
 * roles grant, the tiers it may spend and what it has spent. One fetch feeds
 * every tab of the panel, and every write in the other hooks ends by calling
 * `fetchData` so the tabs cannot disagree about the same organisation.
 *
 * Server scoping is trusted: GET /auth/users?scope=admin returns the members
 * of the caller's home organisation (every user for a platform admin).
 */
interface DirectorySetters {
    setUsers(v: OrgMember[]): void;
    setNotOrgAdmin(v: boolean): void;
    setGroups(v: OrgGroupRow[]): void;
    setOrgRolePerms(v: OrgRolePermissions[]): void;
    setEditablePermissions(v: string[]): void;
    setOrganizations(v: Organization[]): void;
    setMyOrgId(v: string): void;
    setOrgAuthMethod(v: string | null): void;
    setAutoApprove(v: boolean): void;
}

/** One answer into the panel's lists; a refused list keeps what it showed. */
function applyDirectory(d: DirectoryRead, homeOrgId: string | null, set: DirectorySetters) {
    if (d.users) set.setUsers(d.users);
    set.setNotOrgAdmin(d.notOrgAdmin);
    if (d.groups) set.setGroups(d.groups);
    // An install running an older server has no /auth/org-roles; the
    // Roles tab then says so rather than inventing a list.
    if (d.orgRoles) {
        set.setOrgRolePerms(d.orgRoles.roles || []);
        set.setEditablePermissions(d.orgRoles.editablePermissions || []);
    }
    if (!d.organizations) return;
    set.setOrganizations(d.organizations);
    const myOrg = homeOrgId ? d.organizations.find(o => o.id === homeOrgId) : d.organizations[0];
    if (myOrg) {
        set.setMyOrgId(myOrg.id);
        set.setOrgAuthMethod(myOrg.authMethod || null);
        set.setAutoApprove(!!myOrg.autoApproveSSO);
    }
}

/** The directory read and the lists it fills; every answer is applied as it lands. */
function useDirectoryLists(user: UseOrgDirectoryOptions['user']) {
    const [users, setUsers] = useState<OrgMember[]>([]);
    const [groups, setGroups] = useState<OrgGroupRow[]>([]);
    const [orgRolePerms, setOrgRolePerms] = useState<OrgRolePermissions[]>([]);
    const [editablePermissions, setEditablePermissions] = useState<string[]>([]);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [notOrgAdmin, setNotOrgAdmin] = useState(false);
    // Org auto-approve toggle. Only meaningful for orgs whose sign-in method is
    // an external provider (Google/Microsoft) — for password-login orgs we hide
    // the toggle entirely because new accounts are admin-created anyway.
    const [orgAuthMethod, setOrgAuthMethod] = useState<string | null>(null);
    const [autoApprove, setAutoApprove] = useState(false);
    const [myOrgId, setMyOrgId] = useState<string | null>(null);

    const directory = useQuery<DirectoryRead>({
        queryKey: ['orgAdmin', 'directory'],
        staleTime: 0,
        retry: false,
        // Every answer is applied, even one equal to the last: a reload after a write resets the tabs.
        structuralSharing: false,
        queryFn: async () => {
            try {
                return await readOrgDirectory();
            } catch (err) {
                console.error('Failed to fetch org data:', err);
                throw err;
            }
        },
    });
    const loading = directory.isFetching;
    const [applied, setApplied] = useState<DirectoryRead | undefined>(undefined);
    if (directory.data && directory.data !== applied) {
        setApplied(directory.data);
        applyDirectory(directory.data, user?.organizationId ?? null, {
            setUsers, setNotOrgAdmin, setGroups, setOrgRolePerms, setEditablePermissions,
            setOrganizations, setMyOrgId, setOrgAuthMethod, setAutoApprove,
        });
    }
    const { refetch } = directory;
    const fetchData = useCallback(async () => { await refetch(); }, [refetch]);

    return {
        users, groups, orgRolePerms, setOrgRolePerms, editablePermissions, organizations, notOrgAdmin,
        orgAuthMethod, autoApprove, setAutoApprove, myOrgId, loading, fetchData,
    };
}

export default function useOrgDirectory({ user }: UseOrgDirectoryOptions): OrgDirectory {
    const { isSelfHosted } = useDeploymentMode();
    const {
        users, groups, orgRolePerms, setOrgRolePerms, editablePermissions, organizations, notOrgAdmin,
        orgAuthMethod, autoApprove, setAutoApprove, myOrgId, loading, fetchData,
    } = useDirectoryLists(user);

    // Custom tier metadata, for the group's Allowed-tiers editor.
    const customTiersMeta = useCustomTiersMeta();
    const [savingAutoApprove, setSavingAutoApprove] = useState(false);

    // Per-user AI usage, read once; non-blocking for the panel, and a failed read keeps what was shown.
    const usage = useQuery<Map<string, MemberUsage>>({
        queryKey: ['orgAdmin', 'usageByUser', isSelfHosted],
        staleTime: 0,
        retry: false,
        queryFn: async () => {
            try {
                return await readUsageByUser(isSelfHosted);
            } catch (err) {
                if (!(err instanceof UsageRefused)) console.warn('[OrgUsers] Failed to load usage:', err instanceof Error ? err.message : err);
                throw err;
            }
        },
    });
    const usageByUser = usage.data ?? NO_USAGE;

    const handleToggleAutoApprove = async () => {
        if (!myOrgId) return;
        const next = !autoApprove;
        setAutoApprove(next);
        setSavingAutoApprove(true);
        try {
            const res = await settled(apiUrl('PUT /auth/organizations/{id}', { params: { id: myOrgId } }), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoApproveSSO: next }),
            }, 'empty');
            if (!res.ok) {
                setAutoApprove(!next);
            }
        } catch (err) {
            console.error('Failed to update auto-approve:', err);
            setAutoApprove(!next);
        } finally {
            setSavingAutoApprove(false);
        }
    };

    return {
        users,
        groups,
        orgRolePerms, setOrgRolePerms,
        editablePermissions,
        organizations,
        loading,
        notOrgAdmin,
        customTiersMeta,
        usageByUser,
        orgAuthMethod,
        autoApprove,
        savingAutoApprove,
        myOrgId,
        fetchData,
        handleToggleAutoApprove,
    };
}
