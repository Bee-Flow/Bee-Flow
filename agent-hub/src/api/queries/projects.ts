// Projects — the ONLY place that knows the core /api/projects wire contract
// used by the collaborative project workspace (the chat-side "Projects", not
// Studio → Solutions, which keeps its own summary/packaging calls).
//
// Feature areas keep their own modules next to this one (projectChats.ts,
// projectContent.ts) and share `projectKeys`, so one live event can
// invalidate exactly the lists it changed.

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, apiClient } from '../client';
import { toProjectError } from './projectErrors';
import { type ProjectKind, type ProjectRole, type ProjectForm, type ProjectMembers, type ProjectActivityItem, type ProjectResources, type ProjectThread, type MyProjectChat, type InviteForm, type ProjectPrincipals, type TransferOwnerForm } from './projects.types';
import { projectKeys, enc, useMemberMutation } from './useSetMemberColor';
export { projectKeys, useSetMemberColor } from './useSetMemberColor';
export { type ProjectKind, type ProjectRole, type ProjectForm, type ProjectShare,  type ProjectMembers, type ProjectActivityItem,  type ProjectResources, type ProjectThread, type MyProjectChat, type InviteForm, type ProjectPrincipals, type TransferOwnerForm } from './projects.types';

export interface Project {
    id: string;
    name: string;
    description?: string;
    customInstructions?: string;
    color?: string;
    icon?: string;
    knowledgeBaseIds?: string[];
    extractMemories?: boolean;
    ownerId?: string;
    organizationId?: string;
    kind?: ProjectKind | null;
    /** True while `kind` is only the upgrade's guess, which the owner may correct once. */
    kindGuessed?: boolean;
    /** The caller's role, as `GET /api/projects` names it. */
    permission?: ProjectRole;
    /** The caller's role, as `GET /api/projects/:id` names it. */
    role?: ProjectRole;
    /** Optimistic-concurrency token echoed on PUT. */
    version?: number;
    /** The knowledge base that holds files uploaded straight into the project. */
    filesKbId?: string | null;
    createdAt?: string;
    updatedAt?: string;
    /** Set while the project is archived: read-only for everybody, hidden from the rail. */
    archivedAt?: string | null;
    /** The user id of whoever archived it. */
    archivedBy?: string | null;
    /** Whether editors may invite people (the server's default is true). */
    editorsCanInvite?: boolean;
    /** I muted this project's notifications (when the server says so; there is no other read for it). */
    muted?: boolean;
}

/** A PUT refused because someone else saved first. `current` is their version. */
export class ProjectConflictError extends Error {
    current: Project | null;
    constructor(message: string, current: Project | null) {
        super(message);
        this.name = 'ProjectConflictError';
        this.current = current;
    }
}

/** A refusal (404 removed or deleted, 403 no longer a member) will not change on a second try: show it at once. */
export const retryUnlessRefused = (failures: number, error: unknown): boolean =>
    !(error instanceof ApiError && typeof error.status === 'number' && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) && failures < 2;

// ── Projects ────────────────────────────────────────────────────────────────

/** `options` may be the old `enabled` boolean. `includeArchived` lists archived projects too (they carry `archivedAt`). */
export function useProjectsQuery(kind: ProjectKind = 'workspace', options: boolean | { enabled?: boolean; includeArchived?: boolean } = true) {
    const { enabled = true, includeArchived = false } = typeof options === 'boolean' ? { enabled: options } : options;
    return useQuery<Project[], Error>({
        queryKey: projectKeys.list(kind, includeArchived),
        enabled,
        queryFn: async ({ signal }) => {
            const rows = await apiClient.get<Project[]>('/api/projects', { signal, query: includeArchived ? { kind, includeArchived: '1' } : { kind } });
            return Array.isArray(rows) ? rows : [];
        },
    });
}

export function useProjectQuery(projectId: string | null | undefined) {
    return useQuery<Project, Error>({
        queryKey: projectKeys.detail(projectId || ''),
        enabled: !!projectId,
        retry: retryUnlessRefused,
        queryFn: async ({ signal }) => {
            const row = await apiClient.get<Project>(`/api/projects/${enc(projectId!)}`, { signal, retry: false });
            if (!row) throw new Error('Could not load project');
            return row;
        },
    });
}

export function useCreateProject() {
    const qc = useQueryClient();
    return useMutation<Project, Error, ProjectForm>({
        mutationFn: async (form) => {
            let created: Project | null;
            try {
                created = await apiClient.post<Project>('/api/projects', { kind: 'workspace', ...form });
            } catch (e) {
                throw toProjectError(e, 'Could not create the project');
            }
            if (!created?.id) throw new Error('Could not create the project');
            return created;
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'list'] }),
    });
}

export function useUpdateProject(projectId: string) {
    const qc = useQueryClient();
    return useMutation<Project, Error, ProjectForm & { version?: number }>({
        mutationFn: async (patch) => {
            try {
                const saved = await apiClient.put<Project>(`/api/projects/${enc(projectId)}`, patch);
                if (!saved) throw new Error('Could not save the project');
                return saved;
            } catch (e) {
                if (e instanceof ApiError && e.status === 409) {
                    const body = e.body as { error?: string; current?: Project } | null;
                    throw new ProjectConflictError(body?.error || 'Someone else changed this project', body?.current || null);
                }
                if (e instanceof ProjectConflictError) throw e;
                throw toProjectError(e, 'Could not save the project');
            }
        },
        onSuccess: (saved) => {
            qc.setQueryData(projectKeys.detail(projectId), (prev: Project | undefined) => ({ ...(prev || {}), ...saved }));
            qc.invalidateQueries({ queryKey: ['projects', 'list'] });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
        },
    });
}

export function useDeleteProject() {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (projectId) => {
            try {
                await apiClient.delete(`/api/projects/${enc(projectId)}`);
            } catch (e) {
                throw toProjectError(e, 'Could not delete the project');
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'list'] }),
    });
}

function useArchiveMutation(projectId: string, action: 'archive' | 'restore', fallback: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, void>({
        mutationFn: async () => {
            try {
                await apiClient.post(`/api/projects/${enc(projectId)}/${action}`, {});
            } catch (e) {
                throw toProjectError(e, fallback);
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
    });
}

/** Owner: close the project (read-only for everybody, out of the rail). */
export const useArchiveProject = (projectId: string) => useArchiveMutation(projectId, 'archive', 'Could not archive the project');
export const useRestoreProject = (projectId: string) => useArchiveMutation(projectId, 'restore', 'Could not restore the project');

/** Classify a project from before the split (kind `null`), or correct the
 *  upgrade's guess once (`kindGuessed`). Owner only; the server refuses once
 *  the owner's kind is set, and while the project holds what the other side
 *  cannot hold (KIND_HOLDS_OTHER_CONTENT). */
export function useSetProjectKind(projectId: string) {
    const qc = useQueryClient();
    return useMutation<Project, Error, ProjectKind>({
        mutationFn: async (kind) => {
            try {
                const saved = await apiClient.put<Project>(`/api/projects/${enc(projectId)}/kind`, { kind });
                return saved as Project;
            } catch (e) {
                throw toProjectError(e, 'Could not change the project type');
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: projectKeys.all }),
    });
}

// ── Members ─────────────────────────────────────────────────────────────────

export function useProjectMembersQuery(projectId: string | null | undefined) {
    return useQuery<ProjectMembers, Error>({
        queryKey: projectKeys.members(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<Partial<ProjectMembers>>(`/api/projects/${enc(projectId!)}/members`, { signal });
            return {
                ownerId: body?.ownerId || '',
                // Absent from an older server: then nothing is filtered by organisation.
                organizationId: typeof body?.organizationId === 'string' ? body.organizationId : undefined,
                members: Array.isArray(body?.members) ? body!.members! : [],
                people: body?.people || {},
                groups: body?.groups || {},
            };
        },
    });
}

export function useInviteMember(projectId: string) {
    return useMemberMutation<InviteForm>(projectId,
        (form) => apiClient.post(`/api/projects/${enc(projectId)}/share`, form),
        'Could not invite this member');
}

/** Search the project's organisation for people and groups to invite; waits for 2+ characters. */
export function useProjectPrincipals(projectId: string | null | undefined, q: string) {
    const needle = q.trim();
    return useQuery<ProjectPrincipals, Error>({
        queryKey: projectKeys.principals(projectId || '', needle),
        enabled: !!projectId && needle.length >= 2,
        staleTime: 30_000,
        retry: retryUnlessRefused,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<Partial<ProjectPrincipals>>(`/api/projects/${enc(projectId!)}/principals`, { signal, query: { q: needle }, retry: false });
            return { users: Array.isArray(body?.users) ? body!.users! : [], groups: Array.isArray(body?.groups) ? body!.groups! : [] };
        },
    });
}

/** Hand the project to a member (owner, or an organisation admin as a rescue). 409 `owner_changed` when the owner moved meanwhile. */
export function useTransferOwner(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, TransferOwnerForm>({
        mutationFn: async (form) => {
            try {
                await apiClient.post(`/api/projects/${enc(projectId)}/transfer-owner`, form);
            } catch (e) {
                throw toProjectError(e, 'Could not transfer the project');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.members(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
            qc.invalidateQueries({ queryKey: ['projects', 'list'] });
        },
    });
}

export function useChangeMemberRole(projectId: string) {
    return useMemberMutation<{ memberId: string; role: 'editor' | 'viewer' }>(projectId,
        ({ memberId, role }) => apiClient.put(`/api/projects/${enc(projectId)}/members/${enc(memberId)}`, { role }),
        'Could not change the role');
}

export function useRemoveMember(projectId: string) {
    return useMemberMutation<string>(projectId,
        (memberId) => apiClient.delete(`/api/projects/${enc(projectId)}/members/${enc(memberId)}`),
        'Could not remove this member');
}

// ── Activity ────────────────────────────────────────────────────────────────

const ACTIVITY_PAGE = 50;

export function useProjectActivityQuery(projectId: string | null | undefined) {
    return useInfiniteQuery<{ items: ProjectActivityItem[]; hasMore: boolean }, Error>({
        queryKey: projectKeys.activity(projectId || ''),
        enabled: !!projectId,
        initialPageParam: 0,
        getNextPageParam: (last, pages) => (last.hasMore ? pages.reduce((n, p) => n + p.items.length, 0) : undefined),
        queryFn: async ({ signal, pageParam }) => {
            const body = await apiClient.get<{ items?: ProjectActivityItem[]; hasMore?: boolean } | ProjectActivityItem[]>(
                `/api/projects/${enc(projectId!)}/activity`,
                { signal, query: { limit: ACTIVITY_PAGE, offset: pageParam as number } },
            );
            // Older servers answered with a bare array.
            if (Array.isArray(body)) return { items: body, hasMore: false };
            return { items: body?.items || [], hasMore: !!body?.hasMore };
        },
    });
}

// ── Content directory ───────────────────────────────────────────────────────

export function useProjectResourcesQuery(projectId: string | null | undefined) {
    return useQuery<ProjectResources, Error>({
        queryKey: projectKeys.resources(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => (await apiClient.get<ProjectResources>(`/api/projects/${enc(projectId!)}/resources`, { signal })) || {},
    });
}

/** File an item into the project (`attach: true`) or take it out. The caller
 *  must own the item; the server answers 404 otherwise. */
export function useAttachResource(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, { kind: string; id: string; attach: boolean }>({
        mutationFn: async (body) => {
            try {
                await apiClient.put(`/api/projects/${enc(projectId)}/resources`, body);
            } catch (e) {
                throw toProjectError(e, 'Could not update the project');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
            // The pickers say "in another project" from these lists.
            qc.invalidateQueries({ queryKey: ['project-content', 'mine'] });
        },
    });
}

// ── AI chats filed in the project ───────────────────────────────────────────

/** AI chats every member can read (shared into the project). */
export function useProjectThreadsQuery(projectId: string | null | undefined) {
    return useQuery<ProjectThread[], Error>({
        queryKey: projectKeys.threads(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ threads?: ProjectThread[] }>(`/api/projects/${enc(projectId!)}/threads`, { signal });
            return body?.threads || [];
        },
    });
}

/** The caller's own AI chats filed in the project, shared or not. */
export function useMyProjectChatsQuery(projectId: string | null | undefined) {
    return useQuery<MyProjectChat[], Error>({
        queryKey: projectKeys.myChats(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ chats?: MyProjectChat[] }>(`/api/projects/${enc(projectId!)}/my-chats`, { signal });
            return body?.chats || [];
        },
    });
}

/** Share one of my AI chats with the project (`share: true`) or make it private again. */
export function useShareThread(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, { conversationId: string; type: 'direct' | 'agent'; share: boolean }>({
        mutationFn: async ({ conversationId, type, share }) => {
            try {
                if (share) await apiClient.post(`/api/projects/${enc(projectId)}/threads`, { conversationId, type });
                else await apiClient.delete(`/api/projects/${enc(projectId)}/threads/${enc(conversationId)}`, { query: { type } });
            } catch (e) {
                throw toProjectError(e, share ? 'Could not share this chat' : 'Could not stop sharing this chat');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.threads(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.myChats(projectId) });
        },
    });
}
