import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { toProjectError } from './projectErrors';
import { type ProjectKind } from './projects.types';

export const projectKeys = {
    all: ['projects'] as const,
    list: (kind?: ProjectKind, includeArchived = false) => (includeArchived
        ? ['projects', 'list', kind ?? 'all', 'with-archived'] as const
        : ['projects', 'list', kind ?? 'all'] as const),
    principals: (id: string, q: string) => ['projects', id, 'principals', q] as const,
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
    sprints: (id: string) => ['projects', id, 'sprints'] as const,
};

export const enc = encodeURIComponent;

export function useMemberMutation<TVars>(projectId: string, run: (vars: TVars) => Promise<unknown>, fallback: string) {
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

/** Give a person a colour in this project (`null`: the automatic one). The owner may for anyone, everybody for themselves. */
export function useSetMemberColor(projectId: string) {
    return useMemberMutation<{ userId: string; color: string | null }>(projectId,
        ({ userId, color }) => apiClient.put(`/api/projects/${enc(projectId)}/members/${enc(userId)}/color`, { color }),
        'Could not change the colour');
}
