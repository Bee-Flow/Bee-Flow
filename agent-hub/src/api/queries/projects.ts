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

/** A collaborative workspace, or a Studio Solution. `null` is a project from
 *  before the split that nobody has classified yet; it shows in both places. */
export type ProjectKind = 'workspace' | 'solution';
export type ProjectRole = 'owner' | 'editor' | 'viewer';

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
}

export interface ProjectForm {
    name?: string;
    description?: string;
    customInstructions?: string;
    color?: string;
    icon?: string;
    knowledgeBaseIds?: string[];
    extractMemories?: boolean;
    kind?: ProjectKind;
}

export interface ProjectShare {
    /** Share row id: the `:memberId` in the member routes. */
    id: string;
    sharedWithType: 'user' | 'group';
    sharedWithId: string;
    permission: 'editor' | 'viewer';
    createdAt?: string;
}

/** A member as any viewer of the project sees them: a display name, never an e-mail address. */
export interface ProjectPerson {
    name?: string;
    avatar?: string;
    avatarType?: 'emoji' | 'image' | 'url';
    /** The colour the project gave this person; absent for the automatic one. */
    color?: string;
}

export interface ProjectMembers {
    ownerId: string;
    members: ProjectShare[];
    /** Display names for the owner and user members, keyed by user id. */
    people: Record<string, ProjectPerson>;
    /** Display names for group members, keyed by group id. */
    groups: Record<string, { name?: string }>;
}

export interface ProjectActivityItem {
    id: string;
    action: string;
    actorId?: string;
    targetType?: string | null;
    targetId?: string | null;
    details?: Record<string, unknown>;
    createdAt: string;
}

/** One section of GET /:id/resources. `null` means "could not be read", never
 *  "empty": a failed store must not render as nothing filed. */
export type ResourceSection = Array<Record<string, any>> | null;

export interface ProjectResources {
    role?: ProjectRole;
    kind?: ProjectKind | null;
    notebooks?: ResourceSection;
    documents?: ResourceSection;
    meetings?: ResourceSection;
    knowledgeBases?: ResourceSection;
    [section: string]: unknown;
}

export interface ProjectThread {
    id: string;
    type: 'direct' | 'agent';
    /** The agent an agent chat is opened through; null for a direct chat. */
    agentId?: string | null;
    ownerId: string;
    title?: string;
    updatedAt?: string;
    createdAt?: string;
}

export interface MyProjectChat {
    id: string;
    type: 'direct' | 'agent';
    agentId?: string | null;
    title?: string;
    updatedAt?: string;
    shared: boolean;
}

export const projectKeys = {
    all: ['projects'] as const,
    list: (kind?: ProjectKind) => ['projects', 'list', kind ?? 'all'] as const,
    project: (id: string) => ['projects', id] as const,
    detail: (id: string) => ['projects', id, 'detail'] as const,
    members: (id: string) => ['projects', id, 'members'] as const,
    activity: (id: string) => ['projects', id, 'activity'] as const,
    resources: (id: string) => ['projects', id, 'resources'] as const,
    threads: (id: string) => ['projects', id, 'threads'] as const,
    myChats: (id: string) => ['projects', id, 'my-chats'] as const,
    chats: (id: string) => ['projects', id, 'chats'] as const,
    chat: (id: string, chatId: string) => ['projects', id, 'chats', chatId] as const,
    messages: (id: string, chatId: string) => ['projects', id, 'chats', chatId, 'messages'] as const,
    files: (id: string) => ['projects', id, 'files'] as const,
    tasks: (id: string) => ['projects', id, 'tasks'] as const,
};

/** A PUT refused because someone else saved first. `current` is their version. */
export class ProjectConflictError extends Error {
    current: Project | null;
    constructor(message: string, current: Project | null) {
        super(message);
        this.name = 'ProjectConflictError';
        this.current = current;
    }
}

const enc = encodeURIComponent;

// ── Projects ────────────────────────────────────────────────────────────────

export function useProjectsQuery(kind: ProjectKind = 'workspace', enabled = true) {
    return useQuery<Project[], Error>({
        queryKey: projectKeys.list(kind),
        enabled,
        queryFn: async ({ signal }) => {
            const rows = await apiClient.get<Project[]>('/api/projects', { signal, query: { kind } });
            return Array.isArray(rows) ? rows : [];
        },
    });
}

export function useProjectQuery(projectId: string | null | undefined) {
    return useQuery<Project, Error>({
        queryKey: projectKeys.detail(projectId || ''),
        enabled: !!projectId,
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
                const saved = await apiClient.put<Project>(`/api/projects/${enc(projectId)}`, patch, { retry: false });
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
                await apiClient.delete(`/api/projects/${enc(projectId)}`, { retry: false });
            } catch (e) {
                throw toProjectError(e, 'Could not delete the project');
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['projects', 'list'] }),
    });
}

/** Classify a project from before the split (kind `null`), or correct the
 *  upgrade's guess once (`kindGuessed`). Owner only; the server refuses once
 *  the owner's kind is set, and while the project holds what the other side
 *  cannot hold (KIND_HOLDS_OTHER_CONTENT). */
export function useSetProjectKind(projectId: string) {
    const qc = useQueryClient();
    return useMutation<Project, Error, ProjectKind>({
        mutationFn: async (kind) => {
            try {
                const saved = await apiClient.put<Project>(`/api/projects/${enc(projectId)}/kind`, { kind }, { retry: false });
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
                members: Array.isArray(body?.members) ? body!.members! : [],
                people: body?.people || {},
                groups: body?.groups || {},
            };
        },
    });
}

export interface InviteForm { sharedWithType: 'user' | 'group'; sharedWithId: string; permission: 'editor' | 'viewer' }

function useMemberMutation<TVars>(projectId: string, run: (vars: TVars) => Promise<unknown>, fallback: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, TVars>({
        mutationFn: async (vars) => {
            try {
                await run(vars);
            } catch (e) {
                throw toProjectError(e, fallback);
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.members(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
        },
    });
}

export function useInviteMember(projectId: string) {
    return useMemberMutation<InviteForm>(projectId,
        (form) => apiClient.post(`/api/projects/${enc(projectId)}/share`, form, { retry: false }),
        'Could not invite this member');
}

export function useChangeMemberRole(projectId: string) {
    return useMemberMutation<{ memberId: string; role: 'editor' | 'viewer' }>(projectId,
        ({ memberId, role }) => apiClient.put(`/api/projects/${enc(projectId)}/members/${enc(memberId)}`, { role }, { retry: false }),
        'Could not change the role');
}

/** Give a person a colour in this project (`null`: the automatic one). The owner may for anyone, everybody for themselves. */
export function useSetMemberColor(projectId: string) {
    return useMemberMutation<{ userId: string; color: string | null }>(projectId,
        ({ userId, color }) => apiClient.put(`/api/projects/${enc(projectId)}/members/${enc(userId)}/color`, { color }, { retry: false }),
        'Could not change the colour');
}

export function useRemoveMember(projectId: string) {
    return useMemberMutation<string>(projectId,
        (memberId) => apiClient.delete(`/api/projects/${enc(projectId)}/members/${enc(memberId)}`, { retry: false }),
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
                await apiClient.put(`/api/projects/${enc(projectId)}/resources`, body, { retry: false });
            } catch (e) {
                throw toProjectError(e, 'Could not update the project');
            }
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.resources(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
            qc.invalidateQueries({ queryKey: projectKeys.activity(projectId) });
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
                if (share) await apiClient.post(`/api/projects/${enc(projectId)}/threads`, { conversationId, type }, { retry: false });
                else await apiClient.delete(`/api/projects/${enc(projectId)}/threads/${enc(conversationId)}`, { query: { type }, retry: false });
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
