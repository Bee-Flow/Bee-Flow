/** The project queries. Screens call these rather than useQuery. */

import { useInfiniteQuery, useQuery, type QueryClient } from '@tanstack/react-query';

import {
    getProject,
    getProjectMembers,
    getProjectResources,
    listActivity,
    listDirectory,
    listProjects,
    listProjectThreads,
} from '../api/endpoints';
import { projectKeys } from '../api/keys';

export function useProjects(options: { staleTime?: number } = {}) {
    return useQuery({
        queryKey: projectKeys.projects,
        queryFn: ({ signal }) => listProjects(signal),
        ...options,
    });
}

/** After a conversation is filed into a project or taken out of one. */
export function invalidateProjectList(queryClient: QueryClient): void {
    void queryClient.invalidateQueries({ queryKey: projectKeys.projects });
}

export function useProject(id: string) {
    return useQuery({
        queryKey: projectKeys.project(id),
        queryFn: ({ signal }) => getProject(id, signal),
        enabled: Boolean(id),
    });
}

export function useProjectMembers(id: string) {
    return useQuery({
        queryKey: projectKeys.members(id),
        queryFn: ({ signal }) => getProjectMembers(id, signal),
        enabled: Boolean(id),
    });
}

export function useProjectResources(id: string) {
    return useQuery({
        queryKey: projectKeys.resources(id),
        queryFn: ({ signal }) => getProjectResources(id, signal),
        enabled: Boolean(id),
    });
}

export function useProjectThreads(id: string, enabled = true) {
    return useQuery({
        queryKey: projectKeys.threads(id),
        queryFn: ({ signal }) => listProjectThreads(id, signal),
        enabled: Boolean(id) && enabled,
    });
}

/** The activity trail, a page at a time; the tab asks for the next on reaching the end. */
export function useProjectActivity(id: string, enabled = true) {
    return useInfiniteQuery({
        queryKey: projectKeys.activity(id),
        queryFn: ({ signal, pageParam }) => listActivity(id, pageParam, signal),
        initialPageParam: 0,
        getNextPageParam: (last, pages) =>
            last.hasMore ? pages.reduce((n, page) => n + page.items.length, 0) : undefined,
        enabled: Boolean(id) && enabled,
    });
}

/** Names for member ids, when the caller is allowed to see them at all. */
export function useDirectory() {
    return useQuery({
        queryKey: projectKeys.directory,
        queryFn: ({ signal }) => listDirectory(signal),
        staleTime: 10 * 60_000,
        retry: false,
    });
}
