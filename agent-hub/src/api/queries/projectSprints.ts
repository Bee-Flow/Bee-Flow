// Sprints inside a collaborative project: the ONLY place that knows the
// /api/projects/:id/sprints wire contract. Membership lives on the task
// (`sprintId`); assigning also mirrors it into `bf:sprint:*` labels (see
// SprintsPanel) so older clients still show it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectRequest as write } from './projectErrors';
import { projectKeys } from './projects';

export type SprintStatus = 'planned' | 'active' | 'closed';

export interface Sprint {
    id: string;
    name: string;
    goal: string;
    status: SprintStatus;
    /** `YYYY-MM-DD` or null. */
    startDate: string | null;
    endDate: string | null;
    /** Velocity budget in story points; null when the team did not set one. */
    capacityPoints: number | null;
    sortOrder: number;
    itemCount: number;
    pointsTotal: number;
    pointsDone: number;
    doneCount: number;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
    unreadable?: boolean;
}

export interface SprintInput {
    name: string;
    goal?: string;
    startDate?: string | null;
    endDate?: string | null;
    capacityPoints?: number | null;
}

export type SprintPatch = Partial<SprintInput>;

const enc = encodeURIComponent;
const sprintsPath = (projectId: string) => `/api/projects/${enc(projectId)}/sprints`;
const sprintPath = (projectId: string, sprintId: string) => `${sprintsPath(projectId)}/${enc(sprintId)}`;

export function useProjectSprintsQuery(projectId: string | null | undefined) {
    return useQuery<Sprint[], Error>({
        queryKey: projectKeys.sprints(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ sprints?: Sprint[] }>(sprintsPath(projectId!), { signal });
            return Array.isArray(body?.sprints) ? body!.sprints! : [];
        },
    });
}

function useSprintMutation<TVars>(projectId: string, fallback: string, run: (vars: TVars) => Promise<{ sprint?: Sprint } | null | undefined>, touchesTasks = false) {
    const qc = useQueryClient();
    return useMutation<Sprint | undefined, Error, TVars>({
        mutationFn: async (vars) => {
            const body = await write(fallback, () => run(vars));
            return body?.sprint;
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.sprints(projectId) });
            if (touchesTasks) qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) });
        },
    });
}

export function useCreateSprint(projectId: string) {
    return useSprintMutation<SprintInput>(projectId, 'Could not create the sprint',
        (input) => apiClient.post<{ sprint?: Sprint }>(sprintsPath(projectId), input, { retry: false }));
}

export function useUpdateSprint(projectId: string) {
    return useSprintMutation<{ sprintId: string; patch: SprintPatch }>(projectId, 'Could not change the sprint',
        ({ sprintId, patch }) => apiClient.patch<{ sprint?: Sprint }>(sprintPath(projectId, sprintId), patch, { retry: false }));
}

export function useDeleteSprint(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (sprintId) => {
            await write('Could not delete the sprint', () => apiClient.delete(sprintPath(projectId, sprintId), { retry: false }));
        },
        onSuccess: () => {
            qc.invalidateQueries({ queryKey: projectKeys.sprints(projectId) });
            // The tasks keep existing; their sprintId was cleared server-side.
            qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) });
        },
    });
}

export function useAssignSprintItems(projectId: string) {
    return useSprintMutation<{ sprintId: string; taskIds: string[] }>(projectId, 'Could not add the items to the sprint',
        ({ sprintId, taskIds }) => apiClient.post<{ sprint?: Sprint }>(`${sprintPath(projectId, sprintId)}/items`, { taskIds }, { retry: false }), true);
}

export function useUnassignSprintItem(projectId: string) {
    return useSprintMutation<{ sprintId: string; taskId: string }>(projectId, 'Could not remove the item from the sprint',
        ({ sprintId, taskId }) => apiClient.delete(`${sprintPath(projectId, sprintId)}/items/${enc(taskId)}`, { retry: false }).then(() => undefined), true);
}

/** Start the sprint: the project's other active sprint is demoted to planned. */
export function useStartSprint(projectId: string) {
    return useSprintMutation<string>(projectId, 'Could not start the sprint',
        (sprintId) => apiClient.post<{ sprint?: Sprint }>(`${sprintPath(projectId, sprintId)}/start`, {}, { retry: false }));
}

export function useCompleteSprint(projectId: string) {
    return useSprintMutation<string>(projectId, 'Could not complete the sprint',
        (sprintId) => apiClient.post<{ sprint?: Sprint }>(`${sprintPath(projectId, sprintId)}/complete`, {}, { retry: false }));
}
