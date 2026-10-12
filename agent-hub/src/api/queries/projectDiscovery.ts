import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectKeys } from './projects';
export type ProjectItemType = 'chat' | 'task' | 'document' | 'notebook' | 'meeting' | 'file';
export interface ProjectItem { type: ProjectItemType; id: string; title: string; archived?: boolean; threadType?: 'direct' | 'agent'; agentId?: string | null }
export const ITEM_TYPES: ProjectItemType[] = ['chat', 'task', 'document', 'notebook', 'meeting', 'file'];
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}`;
export const discoveryKeys = {
    pins: (id: string) => [...projectKeys.detail(id), 'pins'],
    search: (id: string) => [...projectKeys.detail(id), 'search'],
};
export function useProjectSearch(id: string, q: string, type: string, enabled = true) {
    return useInfiniteQuery({
        queryKey: [...discoveryKeys.search(id), q, type], enabled, initialPageParam: '',
        queryFn: ({ pageParam, signal }) => apiClient.get<{ items: ProjectItem[]; nextCursor: string | null }>(`${base(id)}/search?${new URLSearchParams({ q, ...(type ? { type } : {}), ...(pageParam ? { cursor: pageParam } : {}) })}`, { signal }),
        getNextPageParam: page => page?.nextCursor ?? undefined,
    });
}
export function useProjectPins(id: string) {
    return useQuery({ queryKey: discoveryKeys.pins(id), queryFn: ({ signal }) => apiClient.get<{ items: ProjectItem[] }>(`${base(id)}/pins`, { signal }), refetchInterval: 30_000 });
}
export function useSetProjectPin(id: string) {
    const qc = useQueryClient();
    return useMutation({
        mutationFn: ({ item, pinned }: { item: ProjectItem; pinned: boolean }) => pinned
            ? apiClient.put(`${base(id)}/pins`, { type: item.type, id: item.id }, { retry: false })
            : apiClient.delete(`${base(id)}/pins/${item.type}/${encodeURIComponent(item.id)}`, { retry: false }),
        onSuccess: () => qc.invalidateQueries({ queryKey: discoveryKeys.pins(id) }),
    });
}
export function useProjectFileContent(projectId: string, fileId: string) {
    return useQuery({ queryKey: [...projectKeys.detail(projectId), 'file-content', fileId],
        queryFn: ({ signal }) => apiClient.get<{ file: { name: string; status: string; statusReason?: string }; content: string; available: boolean }>(`${base(projectId)}/files/${encodeURIComponent(fileId)}/content`, { signal }),
    });
}
