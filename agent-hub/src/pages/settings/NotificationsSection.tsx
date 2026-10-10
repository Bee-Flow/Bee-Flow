import React, { useState } from 'react';
import {
    NOTIFICATION_EVENTS, useNotificationPrefs, useSetNotificationPrefs,
    type NotificationChannel, type NotificationEvent,
} from '../../api/queries/notificationPrefs';
import SaveStatus from '../../components/shared/SaveStatus';
import Toggle from '../../components/shared/Toggle';
import { useTranslation } from '../../hooks/useTranslation';

/**
 * Settings → Notifications: what I am told about when something happens in a
 * project, in the bell and by e-mail. One switch per event and channel, saved
 * the moment it moves (only that switch goes to the server).
 */
export default function NotificationsSection() {
    const { t } = useTranslation();
    const query = useNotificationPrefs();
    const save = useSetNotificationPrefs();
    const [savedAt, setSavedAt] = useState<Date | null>(null);

    const labels: Record<NotificationEvent, string> = {
        chat_mention: t('project_collab.prefs.event.chat_mention', 'Mentioned in a team chat'),
        comment_mention: t('project_collab.prefs.event.comment_mention', 'Mentioned in a comment'),
        added: t('project_collab.prefs.event.added', 'Added to a project'),
        role_changed: t('project_collab.prefs.event.role_changed', 'My role in a project changed'),
        removed: t('project_collab.prefs.event.removed', 'Removed from a project'),
        left: t('project_collab.prefs.event.left', 'A member left my project'),
        owner_changed: t('project_collab.prefs.event.owner_changed', 'Project ownership changed'),
        task_assigned: t('project_collab.prefs.event.task_assigned', 'A task was given to me'),
    };
    const channels: Array<[NotificationChannel, string]> = [
        ['bell', t('project_collab.prefs.bell', 'Bell')],
        ['email', t('project_collab.prefs.email', 'E-mail')],
    ];
    const prefs = query.data;
    const saveState = save.isPending ? 'saving' : save.isError ? 'error' : save.isSuccess ? 'saved' : 'idle';

    return (
        <div className="space-y-4" data-testid="notification-prefs">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-[var(--text-primary)] m-0">{t('project_collab.prefs.title', 'Project notifications')}</h2>
                    <p className="text-sm text-[var(--text-secondary)] m-0 mt-1">
                        {t('project_collab.prefs.help', 'Choose how you hear about what happens in your projects. You can also mute a single project in its settings.')}
                    </p>
                </div>
                <SaveStatus saveState={saveState} lastSavedAt={savedAt} onRetry={undefined} />
            </div>
            {query.isError && (
                <p role="alert" className="text-sm text-[var(--error-ink)] m-0" data-testid="notification-prefs-error">
                    {t('project_collab.prefs.load_failed', 'Could not load your notification preferences.')}
                </p>
            )}
            {save.isError && (
                <p role="alert" className="text-sm text-[var(--error-ink)] m-0" data-testid="notification-prefs-save-error">
                    {t('project_collab.prefs.save_failed', 'Could not save that change. Please try again.')}
                </p>
            )}
            {prefs && (
                <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="text-left text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                                <th scope="col" className="px-5 py-3 font-semibold">{t('project_collab.prefs.event', 'What happened')}</th>
                                {channels.map(([channel, label]) => (
                                    <th key={channel} scope="col" className="px-3 py-3 w-24 text-center font-semibold">{label}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {NOTIFICATION_EVENTS.map((event) => (
                                <tr key={event} className="border-t border-[var(--border-subtle)]" data-testid={`notification-row-${event}`}>
                                    <th scope="row" className="px-5 py-3 text-left font-normal text-[var(--text-primary)]">{labels[event]}</th>
                                    {channels.map(([channel, label]) => (
                                        <td key={channel} className="px-3 py-3 text-center">
                                            <Toggle
                                                checked={prefs[channel][event] !== false}
                                                onChange={(next) => save.mutate({ [channel]: { [event]: next } }, { onSuccess: () => setSavedAt(new Date()) })}
                                                ariaLabel={`${labels[event]}: ${label}`}
                                            />
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );
}
