// The task dialog with its mutations, for the two places that make tasks: the
// Tasks tab, and a chat or thread ("make a task from this").

import React, { useCallback, useState } from 'react';
import {
    useCreateTask, useDeleteTask, useUpdateTask, type ProjectTask, type TaskInput, type TaskLink,
} from '../../../../api/queries/projectTasks';
import { useTranslation } from '../../../../hooks/useTranslation';
import useConfirm from '../../../shared/useConfirm';
import { projectErrorText } from '../projectErrorText';
import { canEditProject, type WorkspaceTabId, type WorkspaceTabProps } from '../types';
import { mayDeleteTask } from './DeleteTaskButton';
import TaskDialog from './TaskDialog';
import { routeOfLink } from './taskLinks';

type Open = { task: ProjectTask | null; links?: TaskLink[]; title?: string; description?: string } | null;

/** How a link opens: inside the project, in the tab of its kind. */
export function useOpenTaskLink(props: Pick<WorkspaceTabProps, 'onOpenTab'>) {
    const { onOpenTab } = props;
    return useCallback((link: TaskLink) => {
        const route = routeOfLink(link);
        onOpenTab?.(route.tab as WorkspaceTabId, route.sub);
    }, [onOpenTab]);
}

export function useTaskDialog(props: Pick<WorkspaceTabProps, 'projectId' | 'role' | 'currentUser' | 'onOpenTab'>, labelSuggestions?: string[]) {
    const { projectId, role, currentUser } = props;
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const [open, setOpen] = useState<Open>(null);
    const [error, setError] = useState<string | null>(null);
    const create = useCreateTask(projectId);
    const update = useUpdateTask(projectId);
    const remove = useDeleteTask(projectId);
    const openLink = useOpenTaskLink(props);
    const close = useCallback(() => { setOpen(null); setError(null); }, []);

    const submit = (input: TaskInput) => {
        setError(null);
        const done = { onSuccess: close, onError: (e: Error) => setError(projectErrorText(t, e)) };
        if (open?.task) update.mutate({ id: open.task.id, patch: input }, done);
        else create.mutate(input, done);
    };
    const onDelete = async () => {
        const task = open?.task;
        if (!task) return;
        const ok = await confirm({
            title: t('project_tasks.delete_title', 'Delete this task?'),
            description: t('project_tasks.delete_body', 'It disappears for everyone in the project.'),
            confirmLabel: t('project_tasks.delete', 'Delete'),
            cancelLabel: t('project_content.cancel', 'Cancel'),
            destructive: true,
        });
        if (ok) remove.mutate(task.id, { onSuccess: close, onError: e => setError(projectErrorText(t, e)) });
    };

    const dialog = open ? (
        <>
            <TaskDialog key={open.task?.id || 'new'} projectId={projectId} currentUser={currentUser} task={open.task}
                initialLinks={open.links} initialTitle={open.title} initialDescription={open.description} labelSuggestions={labelSuggestions} role={role} canEdit={canEditProject(role)}
                busy={create.isPending || update.isPending || remove.isPending} error={error}
                onClose={close} onSubmit={submit}
                onDelete={open.task && mayDeleteTask(open.task, currentUser?.id || null, role === 'owner', canEditProject(role)) ? onDelete : undefined} onOpenLink={(l) => { close(); openLink(l); }} />
        </>
    ) : null;
    return {
        openNew: (links?: TaskLink[], title?: string, description?: string) => setOpen({ task: null, links, title, description }),
        openTask: (task: ProjectTask) => setOpen({ task }),
        close,
        isOpenOn: (id: string) => open?.task?.id === id,
        dialog: <>{dialog}{confirmDialog}</>,
    };
}
