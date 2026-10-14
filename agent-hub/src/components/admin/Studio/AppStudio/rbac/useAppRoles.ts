import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import type { DataModel, ModelTable } from '../tables/tablesManagerModel';

/**
 * App Studio RBAC — the authoring hooks for the per-app role model.
 *
 * The authoritative role definitions live in the DATA MODEL (owner-only,
 * server-enforced by the RLS gateway), NOT the app definition — the definition
 * only carries role KEY references (screen/node visibleToRoles). This hook is
 * the thin react-query surface over the two owner-only endpoints that own the
 * model + membership:
 *
 *   GET  /api/studio-apps/:id/schema          → { model, modelVersion }
 *   PUT  /api/studio-apps/:id/schema          ← { model }   (whole data model)
 *   GET  /api/studio-apps/:id/members         → { members }
 *   POST /api/studio-apps/:id/members         ← { userId, roleKey }
 *   DELETE /api/studio-apps/:id/members/:uid
 *
 * Every read degrades a 404 (app has no data model yet, or the viewer can't
 * read it) to an empty/neutral value rather than an error, so the Roles UI
 * renders a friendly empty state instead of crashing.
 *
 * Writes go through the SAME whole-model PUT the server validates (data-model
 * shape + every rowFilter against the bounded SQL subset). saveRoles /
 * saveTableAccess / saveRowFilter therefore READ the freshest cached model and
 * MERGE their slice in, so a role edit never clobbers tables and a rowFilter
 * edit never clobbers roles.
 */

/** One role of the data model (roles live in the model, not the definition). */
export interface AppRole {
    key: string;
    label?: string;
    [key: string]: unknown;
}

/** The roleMapping block: which role an organisation group or the default gets. */
export interface RoleMapping {
    default: string;
    byGroup: Record<string, unknown>;
}

/** One directly assigned person. */
export interface AppMember {
    userId?: string;
    user_id?: string;
    roleKey?: string;
    role_key?: string;
    [key: string]: unknown;
}

/** One organisation group. */
export interface OrgGroup {
    id: string;
    name?: string;
    [key: string]: unknown;
}

/** One organisation user. */
export interface OrgUser {
    id: string;
    name?: string;
    displayName?: string;
    username?: string;
    email?: string;
    [key: string]: unknown;
}

/** A table's access block: the default mode, per-role modes and row rules. */
export interface AccessBlock {
    default?: string;
    roles?: Record<string, unknown>;
    rowFilters?: Record<string, unknown>;
}

/** An access patch; a null entry deletes that role or rule. */
export interface AccessPatch {
    default?: string;
    roles?: Record<string, unknown>;
    rowFilters?: Record<string, string | null | undefined>;
}

/** An Error carrying the HTTP status and parsed body of a failed request. */
interface RequestError extends Error {
    status?: number;
    body?: { error?: string; currentVersion?: unknown; model?: DataModel } | null;
    conflict?: boolean;
}

interface SchemaResponse {
    model?: DataModel | null;
    modelVersion?: unknown;
}

const enc = (v: string | null | undefined) => encodeURIComponent(String(v));
const base = `${API_BASE}/api/studio-apps`;

async function request<T = unknown>(url: string, options: RequestInit = {}): Promise<T | null> {
    const res = await authFetch(url, {
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
        ...options,
    });
    // Owner-only reads answer 404 (invisible) or 403 (readable non-owner) — both
    // mean "no authoring surface here", so a GET degrades to null.
    const isGet = !options.method || options.method === 'GET';
    if (isGet && (res.status === 404 || res.status === 403)) return null;
    let body: T | null = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
        const errBody = body as RequestError['body'];
        const err: RequestError = new Error(errBody?.error || `Request failed (${res.status})`);
        err.status = res.status;
        err.body = errBody;
        throw err;
    }
    return body;
}

/** A blank-but-valid data model, matching server emptyDataModel(). */
function emptyModel(): DataModel {
    return { modelVersion: 1, tables: [], roles: [], roleMapping: { default: 'app', byGroup: {} } };
}

export const APP_SCHEMA_KEY = (appId: string | null) => ['studio-app-schema', appId];
export const APP_MEMBERS_KEY = (appId: string | null) => ['studio-app-members', appId];

/**
 * The primary RBAC hook. Exposes the model's roles/roleMapping/tables, the
 * membership list, and the merge-aware writers. `appId` may be null (the hook
 * simply stays idle).
 */
export default function useAppRoles(appId: string | null) {
    const { t } = useTranslation();
    const qc = useQueryClient();
    // The model version the SERVER last reported, kept out of the cached data so
    // it is never confused with one the client made up. null = not known yet.
    const serverVersionRef = useRef<number | null>(null);
    const schemaKey = APP_SCHEMA_KEY(appId);
    const membersKey = APP_MEMBERS_KEY(appId);

    const schemaQuery = useQuery<DataModel | null>({
        queryKey: schemaKey,
        queryFn: async () => {
            const body = await request<SchemaResponse>(`${base}/${enc(appId)}/schema`);
            // The version lives BESIDE the model on the wire, and it is the ROW's
            // version — not whatever `modelVersion` the stored model happens to
            // carry. Held apart from the data so it can never be confused with
            // one the client invented.
            serverVersionRef.current = Number.isInteger(body?.modelVersion) ? body?.modelVersion as number : null;
            return body && body.model && typeof body.model === 'object' ? body.model : null;
        },
        enabled: !!appId,
        staleTime: 30_000,
        retry: false,
    });

    const membersQuery = useQuery<AppMember[]>({
        queryKey: membersKey,
        queryFn: async () => {
            const body = await request<{ members?: AppMember[] }>(`${base}/${enc(appId)}/members`);
            return Array.isArray(body?.members) ? body?.members as AppMember[] : [];
        },
        enabled: !!appId,
        staleTime: 30_000,
        retry: false,
    });

    const model = schemaQuery.data || null;
    const roles = (Array.isArray(model?.roles) ? model.roles : []) as AppRole[];
    const roleMapping: RoleMapping = (model?.roleMapping && typeof model.roleMapping === 'object')
        ? model.roleMapping
        : { default: 'app', byGroup: {} };
    const tables: ModelTable[] = Array.isArray(model?.tables) ? model.tables : [];
    const members: AppMember[] = Array.isArray(membersQuery.data) ? membersQuery.data : [];

    // The freshest model to merge into: the react-query cache wins (it may hold
    // a just-saved value the local `model` closure hasn't re-rendered with yet).
    const currentModel = (): DataModel => {
        const cached = qc.getQueryData<DataModel | null>(schemaKey);
        return (cached && typeof cached === 'object') ? cached : (model || emptyModel());
    };

    /**
     * Save the WHOLE data model.
     *
     * Every writer here merges into a cached model and PUTs the result, and the
     * cache is 30s stale — so this used to be a blind last-write-wins overwrite
     * of everything. Add a column in Tables, then save a row rule in Roles &
     * access, and the column was gone: the rule's PUT carried the model as it
     * had been read before the column existed, and nothing anywhere said so.
     *
     * `expectedVersion` is the guard the server has always offered (409 with
     * its current model). It is sent ONLY when the server actually reported a
     * version — an app with no data model yet is at version 0, and inventing a
     * number for it would make the very first save conflict with nothing.
     */
    const putModel = async (nextModel: DataModel) => {
        const expected = serverVersionRef.current;
        let body: { modelVersion?: unknown } | null;
        try {
            body = await request<{ modelVersion?: unknown }>(`${base}/${enc(appId)}/schema`, {
                method: 'PUT',
                body: JSON.stringify({
                    model: nextModel,
                    ...(Number.isInteger(expected) ? { expectedVersion: expected } : {}),
                }),
            });
        } catch (err) {
            const requestErr = err as RequestError;
            if (requestErr.status === 409) {
                serverVersionRef.current = Number.isInteger(requestErr.body?.currentVersion)
                    ? requestErr.body?.currentVersion as number
                    : null;
                if (requestErr.body?.model && typeof requestErr.body.model === 'object') {
                    qc.setQueryData(schemaKey, requestErr.body.model);
                }
                qc.invalidateQueries({ queryKey: schemaKey });
                const conflict: RequestError = new Error(t('studio_apps_edit.roles_api.conflict', "The app's data changed somewhere else while this panel was open — it has been reloaded, so try again."));
                conflict.status = 409;
                conflict.conflict = true;
                throw conflict;
            }
            throw err;
        }
        if (Number.isInteger(body?.modelVersion)) serverVersionRef.current = body?.modelVersion as number;
        // Optimistically adopt the model we just persisted, then refetch to pick
        // up the server's canonical version.
        qc.setQueryData(schemaKey, nextModel);
        qc.invalidateQueries({ queryKey: schemaKey });
        return body;
    };

    const saveRolesMutation = useMutation({
        // `tables` is optional and exists for ONE case: roles that arrive with
        // a row rule. The rule lives on the table, the role in `roles`, and
        // saving them in two writes leaves a window in which the role exists
        // and sees everything. One model, one PUT.
        mutationFn: async ({ roles: nextRoles, roleMapping: nextMapping, tables: nextTables }: {
            roles?: AppRole[];
            roleMapping?: RoleMapping;
            tables?: ModelTable[];
        }) => {
            const cur = currentModel();
            const next: DataModel = {
                ...cur,
                roles: Array.isArray(nextRoles) ? nextRoles : (cur.roles || []),
                roleMapping: nextMapping && typeof nextMapping === 'object'
                    ? nextMapping
                    : (cur.roleMapping || { default: 'app', byGroup: {} }),
                ...(Array.isArray(nextTables) ? { tables: nextTables } : {}),
            };
            return putModel(next);
        },
    });

    const saveTableAccessMutation = useMutation({
        mutationFn: async ({ tableId, access: patch }: { tableId: string; access: AccessPatch }) => {
            const cur = currentModel();
            const nextTables = (Array.isArray(cur.tables) ? cur.tables : []).map((t) => {
                if (!t || (t.id !== tableId && t.key !== tableId)) return t;
                const curAccess = (t.access && typeof t.access === 'object') ? t.access as AccessBlock : {} as AccessBlock;
                return { ...t, access: mergeAccess(curAccess, patch) };
            });
            return putModel({ ...cur, tables: nextTables });
        },
    });

    const addMemberMutation = useMutation({
        mutationFn: ({ userId, roleKey }: { userId: string; roleKey: string }) => request(`${base}/${enc(appId)}/members`, {
            method: 'POST',
            body: JSON.stringify({ userId, roleKey }),
        }),
        onSuccess: () => qc.invalidateQueries({ queryKey: membersKey }),
    });

    const removeMemberMutation = useMutation({
        mutationFn: (userId: string | undefined) => request(`${base}/${enc(appId)}/members/${enc(userId)}`, { method: 'DELETE' }),
        onSuccess: () => qc.invalidateQueries({ queryKey: membersKey }),
    });

    return {
        // model slices
        model,
        roles,
        roleMapping,
        tables,
        members,
        // status
        isLoading: !!appId && (schemaQuery.isLoading || membersQuery.isLoading),
        isError: schemaQuery.isError,
        error: schemaQuery.error || null,
        hasModel: !!model,
        refetch: () => { schemaQuery.refetch(); membersQuery.refetch(); },
        // writers (promises)
        saveRoles: (nextRoles?: AppRole[], nextMapping?: RoleMapping, nextTables?: ModelTable[]) => saveRolesMutation.mutateAsync({ roles: nextRoles, roleMapping: nextMapping, tables: nextTables }),
        saveTableAccess: (tableId: string, patch: AccessPatch) => saveTableAccessMutation.mutateAsync({ tableId, access: patch }),
        saveRowFilter: (tableId: string, roleKey: string, expr: unknown) => {
            const trimmed = typeof expr === 'string' ? expr.trim() : '';
            return saveTableAccessMutation.mutateAsync({
                tableId,
                access: { rowFilters: { [roleKey]: trimmed || null } },
            });
        },
        assignMember: (userId: string, roleKey: string) => addMemberMutation.mutateAsync({ userId, roleKey }),
        removeMember: (userId: string | undefined) => removeMemberMutation.mutateAsync(userId),
        savingRoles: saveRolesMutation.isPending,
        savingAccess: saveTableAccessMutation.isPending,
        savingMember: addMemberMutation.isPending || removeMemberMutation.isPending,
    };
}

/**
 * Merge an access patch into a table's access block. `roles` and `rowFilters`
 * are merged key-by-key; a `null` rowFilter/role entry DELETES that key (so
 * clearing a rule doesn't leave a dangling empty string the gateway rejects).
 */
export function mergeAccess(current: AccessBlock, patch: AccessPatch | null | undefined): AccessBlock {
    const out: { default?: string; roles: Record<string, unknown>; rowFilters: Record<string, unknown> } = {
        default: current.default,
        roles: { ...(current.roles && typeof current.roles === 'object' ? current.roles : {}) },
        rowFilters: { ...(current.rowFilters && typeof current.rowFilters === 'object' ? current.rowFilters : {}) },
    };
    if (!patch || typeof patch !== 'object') return out;
    if (typeof patch.default === 'string') out.default = patch.default;
    if (patch.roles && typeof patch.roles === 'object') {
        for (const [k, v] of Object.entries(patch.roles)) {
            if (v == null) delete out.roles[k]; else out.roles[k] = v;
        }
    }
    if (patch.rowFilters && typeof patch.rowFilters === 'object') {
        for (const [k, v] of Object.entries(patch.rowFilters)) {
            if (v == null || v === '') delete out.rowFilters[k]; else out.rowFilters[k] = v;
        }
    }
    return out;
}

/**
 * The org directory (groups + users) used to map GROUPS → role and assign
 * specific USERS → role. Both endpoints require elevated org permissions the
 * app owner may not hold — a 403 degrades to an empty list, and the Roles UI
 * falls back to manual id entry.
 */
export function useOrgDirectory(enabled = true) {
    const groupsQuery = useQuery<OrgGroup[]>({
        queryKey: ['org-directory-groups'],
        queryFn: async () => {
            const body = await request<OrgGroup[]>(`${API_BASE}/auth/groups`);
            return Array.isArray(body) ? body : [];
        },
        enabled: !!enabled,
        staleTime: 60_000,
        retry: false,
    });
    const usersQuery = useQuery<OrgUser[]>({
        queryKey: ['org-directory-users'],
        queryFn: async () => {
            const body = await request<OrgUser[]>(`${API_BASE}/auth/users`);
            return Array.isArray(body) ? body : [];
        },
        enabled: !!enabled,
        staleTime: 60_000,
        retry: false,
    });
    return {
        groups: Array.isArray(groupsQuery.data) ? groupsQuery.data : [],
        users: Array.isArray(usersQuery.data) ? usersQuery.data : [],
        isLoading: (!!enabled) && (groupsQuery.isLoading || usersQuery.isLoading),
        // A 403 is expected (owner without directory perms) — never surfaced as error.
        available: !groupsQuery.isError,
    };
}
