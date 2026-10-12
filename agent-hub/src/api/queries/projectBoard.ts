import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectKeys } from './projects';
import type { ProjectTask, TaskStatus } from './projectTasks';
export interface BoardColumn { id: string; title: string; status: TaskStatus; wipLimit: number | null }
export interface ProjectBoard { columns: BoardColumn[]; assignments: Record<string, string>; version: number }
export const DEFAULT_COLUMNS: BoardColumn[] = ['todo', 'doing', 'done'].map(id => ({ id, title: '', status: id as TaskStatus, wipLimit: null }));
export const boardKey = (id: string) => [...projectKeys.detail(id), 'board'];
const base = (id: string) => `/api/projects/${encodeURIComponent(id)}/board`;
export function taskColumn(task: ProjectTask, columns: BoardColumn[], assignments: Record<string, string>) {
    return columns.find(c => c.id === assignments[task.id] && c.status === task.status) || columns.find(c => c.status === task.status);
}
export function useProjectBoard(id: string) {
    return useQuery({ queryKey: boardKey(id), queryFn: ({ signal }) => apiClient.get<ProjectBoard>(base(id), { signal }) });
}
export function useBoardActions(id: string) {
    const qc = useQueryClient();
    const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: boardKey(id) }), qc.invalidateQueries({ queryKey: projectKeys.tasks(id) })]); };
    const save = useMutation({ mutationFn: (body: Pick<ProjectBoard, 'columns' | 'version'>) => apiClient.put<ProjectBoard>(base(id), body, { retry: false }), onSuccess: refresh });
    const move = useMutation({ mutationFn: ({ taskId, ...body }: { taskId: string; columnId: string; beforeId: string | null }) => apiClient.patch(`${base(id)}/tasks/${encodeURIComponent(taskId)}`, body, { retry: false }), onSuccess: refresh });
    const create = useMutation({ mutationFn: (body: { columnId: string; title: string }) => apiClient.post<{ id: string }>(`${base(id)}/tasks`, body, { retry: false }), onSuccess: refresh });
    return { save, move, create };
}
