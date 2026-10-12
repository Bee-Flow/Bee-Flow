// Tasks inside a collaborative project: the ONLY place that knows the
// /api/projects/:id/tasks wire contract. The list is small (the server caps it)
// so one query holds all of it and every change refetches it.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectRequest as write } from './projectErrors';
import { projectKeys, type ProjectRole } from './projects';

export type TaskStatus = 'todo' | 'doing' | 'done';
export const TASK_STATUSES: readonly TaskStatus[] = ['todo', 'doing', 'done'];

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export const TASK_PRIORITIES: readonly TaskPriority[] = ['low', 'normal', 'high', 'urgent'];

export interface ChecklistItem { id: string; text: string; done: boolean }

/** Where a task came from: a meeting and one of its action items. */
export interface TaskSource { kind: 'meeting'; id: string; itemId: string }

/** What a task points at, including another task. A thread is a message of a chat that has replies. */
export type TaskLink =
    | { kind: 'document' | 'notebook' | 'meeting' | 'chat'; id: string }
    | { kind: 'task'; id: string; relation?: 'depends_on' }
    | { kind: 'thread'; id: string; chatId: string };

export interface ProjectTask {
    id: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    itemType?: 'epic' | 'story' | 'user-story' | 'task';
    parentTaskId?: string | null;
    storyPoints?: number | null;
    /** The sprint this task is planned in; null when it sits in the backlog. */
    sprintId?: string | null;
    labels: string[];
    checklist: ChecklistItem[];
    /** Position in its column on the board (ascending). */
    sortOrder: number;
    source: TaskSource | null;
    assigneeIds: string[];
    links: TaskLink[];
    /** `YYYY-MM-DD` or null. */
    startDate?: string | null;
    dueDate: string | null;
    createdBy: string;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    unreadable?: boolean;
}

export interface TaskInput {
    title: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    itemType?: ProjectTask['itemType'];
    parentTaskId?: string | null;
    storyPoints?: number | null;
    sprintId?: string | null;
    labels?: string[];
    checklist?: ChecklistItem[];
    assigneeIds?: string[];
    links?: TaskLink[];
    startDate?: string | null;
    dueDate?: string | null;
    source?: TaskSource;
}

export interface PokerSession {
    sessionId: string;
    taskId: string;
    taskTitle: string;
    phase: 'voting' | 'revealed';
    startedBy: string;
    voterIds: string[];
    ownVote: string | null;
    votes: Record<string, string> | null;
    /** Queued task ids behind the current one (a session started with `taskIds`). */
    queueTaskIds?: string[];
    /** Opened titles of the queue, parallel to `queueTaskIds`; null for one that went away. */
    queueTitles?: (string | null)[];
}

/** A change to a task, or a move: `beforeId` puts it in `status`'s column right before that task (null: at the end). */
export type TaskPatch = Partial<Omit<TaskInput, 'source'>> & { beforeId?: string | null };

/** One action item of a meeting, as a task suggestion. */
export interface MeetingTaskSuggestion {
    itemId: string;
    text: string;
    assigneeName: string;
    suggestedAssigneeId: string | null;
    dueDate: string | null;
    /** Where in the recording (`12:05`), or ''. */
    at: string;
    done: boolean;
    /** The task it already became, if any. */
    createdTaskId: string | null;
}

const enc = encodeURIComponent;
const tasksPath = (projectId: string) => `/api/projects/${enc(projectId)}/tasks`;

export function linkKey(l: TaskLink): string {
    return l.kind === 'thread' ? `thread:${l.chatId}:${l.id}` : `${l.kind}:${l.id}`;
}

export function useProjectTasksQuery(projectId: string | null | undefined) {
    return useQuery<{ tasks: ProjectTask[]; role: ProjectRole | null }, Error>({
        queryKey: projectKeys.tasks(projectId || ''),
        enabled: !!projectId,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ tasks?: ProjectTask[]; role?: ProjectRole }>(tasksPath(projectId!), { signal });
            return { tasks: Array.isArray(body?.tasks) ? body!.tasks! : [], role: body?.role || null };
        },
    });
}

const pokerPath = (projectId: string) => `${tasksPath(projectId)}/poker/session`;

export function usePokerSessionQuery(projectId: string) {
    return useQuery<PokerSession | null, Error>({
        queryKey: [...projectKeys.tasks(projectId), 'poker-session'],
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ session?: PokerSession | null }>(pokerPath(projectId), { signal });
            return body?.session || null;
        },
        refetchInterval: query => query.state.data?.phase ? 3000 : false,
    });
}

function usePokerAction<TInput extends object>(projectId: string, action: string) {
    const qc = useQueryClient();
    return useMutation<{ session?: PokerSession | null; task?: ProjectTask; ok?: boolean }, Error, TInput>({
        mutationFn: async input => {
            const body = await write('Could not update planning poker',
                () => apiClient.post<{ session?: PokerSession | null; task?: ProjectTask; ok?: boolean }>(pokerPath(projectId) + `/${action}`, input, { retry: false }));
            if (!body) throw new Error('Could not update planning poker');
            return body;
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) }); },
    });
}

/** Start on one task (`taskId`) or on a queue (`taskIds`: the first is estimated now, the rest follow). */
export function useStartPokerSession(projectId: string) { return usePokerAction<{ taskId?: string; taskIds?: string[] }>(projectId, 'start'); }
export function useCastPokerVote(projectId: string) { return usePokerAction<{ sessionId: string; vote: string }>(projectId, 'vote'); }
export function useRevealPokerVotes(projectId: string) { return usePokerAction<{ sessionId: string }>(projectId, 'reveal'); }
export function useFinishPokerSession(projectId: string) { return usePokerAction<{ sessionId: string; storyPoints: number }>(projectId, 'finish'); }
/** Save the agreed estimate on the current task and open the next queued one (the session completes at the end of the queue). */
export function useNextPokerTask(projectId: string) { return usePokerAction<{ sessionId: string; storyPoints: number }>(projectId, 'next'); }
export function useCancelPokerSession(projectId: string) { return usePokerAction<{ sessionId: string }>(projectId, 'cancel'); }

export function useCreateTask(projectId: string) {
    const qc = useQueryClient();
    return useMutation<ProjectTask, Error, TaskInput>({
        mutationFn: async (input) => {
            const body = await write('Could not create the task', () => apiClient.post<{ task?: ProjectTask }>(tasksPath(projectId), input, { retry: false }));
            if (!body?.task) throw new Error('Could not create the task');
            return body.task;
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) }); },
    });
}

export function useUpdateTask(projectId: string) {
    const qc = useQueryClient();
    const key = projectKeys.tasks(projectId);
    const mutationKey = [...key, 'update'];
    return useMutation<ProjectTask, Error, { id: string; patch: TaskPatch }, { previous?: { tasks: ProjectTask[]; role: ProjectRole | null } }>({
        mutationKey,
        mutationFn: async ({ id, patch }) => {
            const body = await write('Could not change the task', () => apiClient.patch<{ task?: ProjectTask }>(`${tasksPath(projectId)}/${enc(id)}`, patch, { retry: false }));
            if (!body?.task) throw new Error('Could not change the task');
            return body.task;
        },
        // A status change or a hand-over shows at once; the server's answer replaces it.
        onMutate: async ({ id, patch }) => {
            // Only the list: the key is also a prefix of the meeting suggestions, which this change does not touch.
            await qc.cancelQueries({ queryKey: key, exact: true });
            const previous = qc.getQueryData<{ tasks: ProjectTask[]; role: ProjectRole | null }>(key);
            if (previous) {
                const { beforeId, ...fields } = patch;
                const held = previous.tasks.find(t => t.id === id);
                const column = fields.status ?? held?.status;
                // A move shows in its place at once: between its neighbours, or at the end of the column.
                let sortOrder: number | undefined;
                if (beforeId !== undefined && column) {
                    const before = beforeId ? previous.tasks.find(t => t.id === beforeId) : null;
                    sortOrder = before
                        ? before.sortOrder - 0.5
                        : Math.max(0, ...previous.tasks.filter(t => t.status === column && t.id !== id).map(t => t.sortOrder)) + 1000;
                }
                qc.setQueryData(key, {
                    ...previous,
                    tasks: previous.tasks.map(t => (t.id === id ? { ...t, ...fields, ...(sortOrder !== undefined ? { sortOrder } : {}) } as ProjectTask : t)),
                });
            }
            return { previous };
        },
        onError: (_e, _v, ctx) => { if (ctx?.previous) qc.setQueryData(key, ctx.previous); },
        // While a newer change is still on its way, a refetch now would bring back the server's older order over it.
        // The last one to settle refetches (this one still counts as mutating here).
        onSettled: () => { if (qc.isMutating({ mutationKey }) <= 1) qc.invalidateQueries({ queryKey: key }); },
    });
}

export function useDeleteTask(projectId: string) {
    const qc = useQueryClient();
    return useMutation<void, Error, string>({
        mutationFn: async (id) => {
            await write('Could not delete the task', () => apiClient.delete(`${tasksPath(projectId)}/${enc(id)}`, { retry: false }));
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) }); },
    });
}

/** Make several tasks at once (from a meeting's action items); items already made from the same source are skipped by the server. */
export function useCreateTasksBatch(projectId: string) {
    const qc = useQueryClient();
    return useMutation<{ tasks: ProjectTask[]; skipped: number }, Error, TaskInput[]>({
        mutationFn: async (items) => {
            const body = await write('Could not create the tasks', () => apiClient.post<{ tasks?: ProjectTask[]; skipped?: number }>(`${tasksPath(projectId)}/batch`, { items }, { retry: false }));
            return { tasks: body?.tasks || [], skipped: body?.skipped || 0 };
        },
        onSuccess: () => { qc.invalidateQueries({ queryKey: projectKeys.tasks(projectId) }); },
    });
}

/** The action items of a meeting filed in the project, ready to become tasks. */
export function useMeetingTaskSuggestions(projectId: string, meetingId: string | null) {
    return useQuery<{ meeting: { id: string; title: string }; suggestions: MeetingTaskSuggestion[] }, Error>({
        queryKey: [...projectKeys.tasks(projectId), 'suggestions', meetingId],
        enabled: !!meetingId,
        // What has become a task changes with every batch; always ask again when the dialog opens.
        staleTime: 0,
        gcTime: 0,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<{ meeting?: { id: string; title: string }; suggestions?: MeetingTaskSuggestion[] }>(
                `/api/projects/${enc(projectId)}/meetings/${enc(meetingId!)}/task-suggestions`, { signal });
            return { meeting: body?.meeting || { id: meetingId!, title: '' }, suggestions: Array.isArray(body?.suggestions) ? body!.suggestions! : [] };
        },
    });
}

/** What the AI suggests for a task: nothing is saved until the person accepts it. */
export interface TaskSuggestion {
    title: string;
    description: string;
    priority: TaskPriority;
    labels: string[];
    checklist: ChecklistItem[];
    /** A project member, only when the notes or the task make it plain. */
    assigneeId: string | null;
}

export interface MeetingTaskImprovement extends TaskSuggestion { itemId: string }

/** The AI expands a meeting's action items into full tasks (suggestions only). */
export function useImproveMeetingTasks(projectId: string, meetingId: string) {
    return useMutation<MeetingTaskImprovement[], Error, void>({
        mutationFn: async () => {
            const body = await write('The AI could not improve the tasks', () => apiClient.post<{ items?: MeetingTaskImprovement[] }>(
                `/api/projects/${enc(projectId)}/meetings/${enc(meetingId)}/task-suggestions/improve`, {}, { retry: false }));
            return Array.isArray(body?.items) ? body!.items! : [];
        },
    });
}

/** The AI's suggestion to improve one saved task. */
export function useImproveTask(projectId: string) {
    return useMutation<TaskSuggestion, Error, string>({
        mutationFn: async (taskId) => {
            const body = await write('The AI could not improve the task', () => apiClient.post<{ suggestion?: TaskSuggestion }>(
                `${tasksPath(projectId)}/${enc(taskId)}/improve`, {}, { retry: false }));
            if (!body?.suggestion) throw new Error('The AI could not improve the task');
            return body.suggestion;
        },
    });
}
