// What I am told about, per channel (bell, e-mail), and which projects I have
// muted. The server side is routes/notificationPrefs.js and the /mute routes of
// routes/projects.js.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../client';
import { projectKeys, type Project } from './projects';

export const NOTIFICATION_EVENTS = [
    'chat_mention', 'comment_mention', 'added', 'role_changed', 'removed', 'left', 'owner_changed', 'task_assigned',
] as const;
export type NotificationEvent = typeof NOTIFICATION_EVENTS[number];
export type NotificationChannel = 'bell' | 'email';

export type NotificationPrefs = Record<NotificationChannel, Record<NotificationEvent, boolean>>;
/** A change: only the events that moved. */
export type NotificationPrefsPatch = { [C in NotificationChannel]?: Partial<Record<NotificationEvent, boolean>> };

export const notificationPrefsKeys = {
    me: ['notificationPrefs', 'me'] as const,
};

const PREFS_URL = '/api/me/notification-prefs';

export function useNotificationPrefs() {
    return useQuery<NotificationPrefs, Error>({
        queryKey: notificationPrefsKeys.me,
        queryFn: async ({ signal }) => {
            const body = await apiClient.get<NotificationPrefs>(PREFS_URL, { signal, retry: false });
            if (!body) throw new Error('Could not load the notification preferences');
            return body;
        },
    });
}

/** Save some preferences. The switches move at once and move back when the server refuses. */
export function useSetNotificationPrefs() {
    const qc = useQueryClient();
    return useMutation<NotificationPrefs, Error, NotificationPrefsPatch, { previous?: NotificationPrefs }>({
        mutationFn: async (patch) => {
            const body = await apiClient.put<NotificationPrefs>(PREFS_URL, patch, { retry: false });
            if (!body) throw new Error('Could not save the notification preferences');
            return body;
        },
        onMutate: async (patch) => {
            await qc.cancelQueries({ queryKey: notificationPrefsKeys.me });
            const previous = qc.getQueryData<NotificationPrefs>(notificationPrefsKeys.me);
            if (previous) {
                qc.setQueryData<NotificationPrefs>(notificationPrefsKeys.me, {
                    bell: { ...previous.bell, ...patch.bell },
                    email: { ...previous.email, ...patch.email },
                });
            }
            return { previous };
        },
        onError: (_e, _patch, ctx) => { if (ctx?.previous) qc.setQueryData(notificationPrefsKeys.me, ctx.previous); },
        onSuccess: (saved) => { qc.setQueryData(notificationPrefsKeys.me, saved); },
    });
}

export function useSetProjectMute(projectId: string) {
    const qc = useQueryClient();
    return useMutation<boolean, Error, boolean>({
        mutationFn: async (muted) => {
            const url = `/api/projects/${encodeURIComponent(projectId)}/mute`;
            const body = muted
                ? await apiClient.put<{ muted: boolean }>(url, {}, { retry: false })
                : await apiClient.delete<{ muted: boolean }>(url, { retry: false });
            return body?.muted ?? muted;
        },
        // `Project.muted` (GET /api/projects/:id) is the one source of truth.
        onSuccess: (muted) => {
            qc.setQueryData(projectKeys.detail(projectId), (prev: Project | undefined) => (prev ? { ...prev, muted } : prev));
            qc.invalidateQueries({ queryKey: projectKeys.detail(projectId) });
        },
    });
}
