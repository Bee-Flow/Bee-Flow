import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';

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

/**
 * What the organisation IS: its members, its groups, the permissions its
 * roles grant, the tiers it may spend and what it has spent. One fetch feeds
 * every tab of the panel, and every write in the other hooks ends by calling
 * `fetchData` so the tabs cannot disagree about the same organisation.
 *
 * Server scoping is trusted: GET /auth/users already returns exactly the
 * members the caller may see.
 */
export default function useOrgDirectory({ user }: UseOrgDirectoryOptions): OrgDirectory {
    const [users, setUsers] = useState<OrgMember[]>([]);
    const [groups, setGroups] = useState<OrgGroupRow[]>([]);
    const [orgRolePerms, setOrgRolePerms] = useState<OrgRolePermissions[]>([]);
    const [editablePermissions, setEditablePermissions] = useState<string[]>([]);
    const [organizations, setOrganizations] = useState<Organization[]>([]);
    const [loading, setLoading] = useState(true);

    // Custom tier metadata — used alongside the four standard tiers in the
    // group's Allowed-tiers editor. Empty allowedTiers on a group means "no
    // restriction"; non-empty = only those ids are usable by group members.
    const [customTiersMeta, setCustomTiersMeta] = useState<CustomTierMeta[]>([]);

    // Per-user AI usage (last 30 days)
    const [usageByUser, setUsageByUser] = useState<Map<string, MemberUsage>>(new Map());

    // Org auto-approve toggle. Only meaningful for orgs whose sign-in method is
    // an external provider (Google/Microsoft) — for password-login orgs we hide
    // the toggle entirely because new accounts are admin-created anyway.
    const [orgAuthMethod, setOrgAuthMethod] = useState<string | null>(null);
    const [autoApprove, setAutoApprove] = useState(false);
    const [savingAutoApprove, setSavingAutoApprove] = useState(false);
    const [myOrgId, setMyOrgId] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        setLoading(true);
        try {
            // /auth/roles (the install-wide SYSTEM role table) is no longer
            // fetched here: the only thing left reading it was a badge that
            // counted three of its rows, and the panel is about ORG roles.
            const [usersRes, groupsRes, orgsRes, orgRolesRes] = await Promise.all([
                authFetch(`${API_BASE}/auth/users`),
                authFetch(`${API_BASE}/auth/groups`),
                authFetch(`${API_BASE}/auth/organizations`),
                authFetch(`${API_BASE}/auth/org-roles`),
            ]);
            if (usersRes.ok) setUsers(await usersRes.json());
            if (groupsRes.ok) setGroups(await groupsRes.json());
            // An install running an older server has no /auth/org-roles; the
            // Roles tab then says so rather than inventing a list.
            if (orgRolesRes.ok) {
                const body: { roles?: OrgRolePermissions[]; editablePermissions?: string[] } | null = await orgRolesRes.json();
                setOrgRolePerms(body?.roles || []);
                setEditablePermissions(body?.editablePermissions || []);
            }
            if (orgsRes.ok) {
                const orgs: Organization[] = await orgsRes.json();
                setOrganizations(orgs);
                const myOrg = user?.organizationId
                    ? orgs.find(o => o.id === user.organizationId)
                    : orgs[0];
                if (myOrg) {
                    setMyOrgId(myOrg.id);
                    setOrgAuthMethod(myOrg.authMethod || null);
                    setAutoApprove(!!myOrg.autoApproveSSO);
                }
            }
        } catch (err) {
            console.error('Failed to fetch org data:', err);
        } finally {
            setLoading(false);
        }
    }, [user?.organizationId]);

    useEffect(() => { fetchData(); }, [fetchData]);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/config/custom-tiers-list`);
                if (res.ok) {
                    const data: { tiers?: CustomTierMeta[] } | null = await res.json();
                    if (Array.isArray(data?.tiers)) setCustomTiersMeta(data.tiers);
                }
            } catch { /* non-critical */ }
        })();
    }, []);

    // Fetch per-user AI usage (last 30 days) once; non-blocking for the panel.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/usage/by-user?days=30`);
                if (!res.ok) return;
                const rows: Array<{ user_id: string; calls?: unknown; estimated_cost?: unknown }> = await res.json();
                if (cancelled) return;
                const map = new Map<string, MemberUsage>();
                for (const r of rows) {
                    map.set(r.user_id, {
                        calls: Number(r.calls) || 0,
                        cost: Number(r.estimated_cost) || 0,
                    });
                }
                setUsageByUser(map);
            } catch (err) {
                console.warn('[OrgUsers] Failed to load usage:', err instanceof Error ? err.message : err);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleToggleAutoApprove = async () => {
        if (!myOrgId) return;
        const next = !autoApprove;
        setAutoApprove(next);
        setSavingAutoApprove(true);
        try {
            const res = await authFetch(`${API_BASE}/auth/organizations/${myOrgId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ autoApproveSSO: next }),
            });
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
