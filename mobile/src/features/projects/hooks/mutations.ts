/**
 * Project writes. Each refreshes what it changed — the one project's queries
 * (they all nest under its key), the list and the overview — and hands the
 * screen its own feedback (close a sheet, toast, navigate) as handlers.
 */

import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import {
    changeMemberRole,
    createProject,
    deleteProject,
    fileResource,
    removeMember,
    shareProject,
    updateProject,
    type Filing,
    type Invite,
} from '../api/endpoints';
import { projectKeys } from '../api/keys';
import { bodyFrom, type ProjectDraft } from '../model/form';
import type { Project, ProjectRole } from '../model/types';

interface Handlers<D> {
    onSuccess?: (data: D) => void;
}

/** Everything about one project, plus the list and the overview it appears in. */
export function refreshProject(queryClient: QueryClient, id: string): void {
    void queryClient.invalidateQueries({ queryKey: projectKeys.project(id) });
    void queryClient.invalidateQueries({ queryKey: projectKeys.projects });
}

export function useCreateProject(handlers: Handlers<Project> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (draft: ProjectDraft) => createProject(bodyFrom(draft)),
        onSuccess: (project) => {
            void queryClient.invalidateQueries({ queryKey: projectKeys.projects });
            handlers.onSuccess?.(project);
        },
    });
}

/** Sends the version it was opened on: a colleague's save in between is a 409, said as such. */
export function useUpdateProject(id: string, version: number, handlers: Handlers<Project> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (draft: ProjectDraft) => updateProject(id, bodyFrom(draft, version)),
        onSuccess: (project) => {
            refreshProject(queryClient, id);
            handlers.onSuccess?.(project);
        },
    });
}

export function useDeleteProject(handlers: Handlers<string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (id: string) => deleteProject(id).then(() => id),
        onSuccess: (id) => {
            queryClient.removeQueries({ queryKey: projectKeys.project(id) });
            void queryClient.invalidateQueries({ queryKey: projectKeys.projects });
            handlers.onSuccess?.(id);
        },
    });
}

export function useShareProject(id: string, handlers: Handlers<void> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (invite: Invite) => shareProject(id, invite).then(() => undefined),
        onSuccess: () => {
            refreshProject(queryClient, id);
            handlers.onSuccess?.();
        },
    });
}

export function useChangeMemberRole(id: string) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({ memberId, role }: { memberId: string; role: Exclude<ProjectRole, 'owner'> }) =>
            changeMemberRole(id, memberId, role),
        onSuccess: () => refreshProject(queryClient, id),
    });
}

/** Removing someone, or — with your own share — leaving. */
export function useRemoveMember(id: string, handlers: Handlers<string> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (memberId: string) => removeMember(id, memberId).then(() => memberId),
        onSuccess: (memberId) => {
            refreshProject(queryClient, id);
            handlers.onSuccess?.(memberId);
        },
    });
}

/**
 * File something in or take it out. It changes what the graph draws and what
 * the checks find, both of which nest under the project's key, and the
 * overview's tallies; the picker's own list is refreshed too.
 */
export function useFileResource(id: string, handlers: Handlers<Filing> = {}) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (filing: Filing) => fileResource(id, filing).then(() => filing),
        onSuccess: (filing) => {
            refreshProject(queryClient, id);
            void queryClient.invalidateQueries({ queryKey: projectKeys.candidates(filing.kind) });
            handlers.onSuccess?.(filing);
        },
    });
}
