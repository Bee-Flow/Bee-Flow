/**
 * The project endpoints: /api/projects → routes/projects.js, gated by
 * requireModule('projects') + requireCapability('projects'), so a 403 is a
 * licensing answer rather than a failure. Plus the best-effort directory read
 * that turns member ids into names.
 *
 * Writes never retry (the client's default for anything but a read): a
 * membership change that timed out may still have landed.
 */

import { api } from '@/core/api/client';
import { nullable, pick } from '@/core/api/contract';
import { withId } from '@/shared/lib/withId';

import {
    readActivityPage,
    readGroups,
    readPeople,
    readProject,
    readProjectDetail,
    readProjectMembers,
    readProjectResources,
    readProjectRows,
    readShares,
    readThreadRows,
} from './readers';
import type { ProjectBody } from '../model/form';
import type {
    ActivityPage,
    Directory,
    Project,
    ProjectDetail,
    ProjectMembers,
    ProjectResources,
    ProjectRole,
    ProjectShare,
    ProjectThread,
} from '../model/types';

export const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

/** Bare array, ordered by `updated_at DESC` server-side. */
export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
    return withId(readProjectRows(await api.get<unknown>('/api/projects', { signal })));
}

export async function getProject(id: string, signal?: AbortSignal): Promise<ProjectDetail | null> {
    return nullable(readProjectDetail)(await api.get<unknown>(projectPath(id), { signal }));
}

export async function getProjectMembers(id: string, signal?: AbortSignal): Promise<ProjectMembers | null> {
    return nullable(readProjectMembers)(await api.get<unknown>(`${projectPath(id)}/members`, { signal }));
}

/**
 * Everything filed into a project. Each section comes back `null` when its
 * store was unavailable, which the server distinguishes from `[]` on purpose —
 * see routes/projects.js `load()`.
 */
export async function getProjectResources(id: string, signal?: AbortSignal): Promise<ProjectResources | null> {
    return nullable(readProjectResources)(await api.get<unknown>(`${projectPath(id)}/resources`, { signal }));
}

/** Conversations shared INTO the project (`shared_scope = 'project'`). */
export async function listProjectThreads(id: string, signal?: AbortSignal): Promise<ProjectThread[]> {
    const res = await api.get<unknown>(`${projectPath(id)}/threads`, { signal, query: { limit: 50 } });
    return withId(readThreadRows(pick(res, 'threads')));
}

export const ACTIVITY_PAGE = 30;

/** One page of the durable activity trail, newest first. */
export async function listActivity(id: string, offset: number, signal?: AbortSignal): Promise<ActivityPage> {
    const res = await api.get<unknown>(`${projectPath(id)}/activity`, {
        signal,
        query: { limit: ACTIVITY_PAGE, offset },
    });
    const page = readActivityPage(res);
    return { items: withId(page.items), hasMore: page.hasMore };
}

// ── Writes ──────────────────────────────────────────────────────────

export async function createProject(body: ProjectBody): Promise<Project> {
    return readProject(await api.post<unknown>('/api/projects', body));
}

/** A stale `version` is a 409 whose message says someone else saved first. */
export async function updateProject(id: string, body: Partial<ProjectBody>): Promise<Project> {
    return readProject(await api.put<unknown>(projectPath(id), body));
}

/** Owner only. Filed work is detached and handed back, never deleted with it. */
export async function deleteProject(id: string): Promise<void> {
    await api.delete<unknown>(projectPath(id));
}

export interface Invite {
    sharedWithType: 'user' | 'group';
    sharedWithId: string;
    permission: Exclude<ProjectRole, 'owner'>;
}

/** Owner only; the server refuses a person or group from another organisation. */
export async function shareProject(id: string, invite: Invite): Promise<ProjectShare[]> {
    return withId(readShares(pick(await api.post<unknown>(`${projectPath(id)}/share`, invite), 'shares')));
}

export async function changeMemberRole(id: string, memberId: string, role: Exclude<ProjectRole, 'owner'>): Promise<void> {
    await api.put<unknown>(`${projectPath(id)}/members/${encodeURIComponent(memberId)}`, { role });
}

/** The owner removes anyone; anyone else only their own share (leaving). */
export async function removeMember(id: string, memberId: string): Promise<void> {
    await api.delete<unknown>(`${projectPath(id)}/members/${encodeURIComponent(memberId)}`);
}

export interface Filing {
    kind: string;
    itemId: string;
    attach: boolean;
}

/** File one of your own things in, or take it out. Editor on the project AND owner of the item. */
export async function fileResource(id: string, { kind, itemId, attach }: Filing): Promise<void> {
    await api.put<unknown>(`${projectPath(id)}/resources`, { kind, id: itemId, attach });
}

/**
 * Names for the ids a project's member list is made of.
 *
 * `project_shares` stores only `shared_with_id`, and the only resolvers are
 * `/auth/users` and `/auth/groups`, which refuse anyone without manage_users,
 * admin_security or org_admin — most people on a phone. So this is
 * best-effort and never throws: an admin sees names, a member sees roles.
 */
export async function listDirectory(signal?: AbortSignal): Promise<Directory> {
    const [users, groups] = await Promise.all([
        api.get<unknown>('/auth/users', { signal, retry: false }).catch(() => null),
        api.get<unknown>('/auth/groups', { signal, retry: false }).catch(() => null),
    ]);
    return { users: withId(readPeople(users)), groups: withId(readGroups(groups)) };
}
