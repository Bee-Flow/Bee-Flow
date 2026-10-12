import React from 'react';
import { CalendarDays, X } from 'lucide-react';
import { useProjectFileContent, useProjectPins, useSetProjectPin, type ProjectItem } from '../../../api/queries/projectDiscovery';
import { useProjectTasksQuery } from '../../../api/queries/projectTasks';
import useTranslation from '../../../hooks/useTranslation';
import { canEditProject, type WorkspaceTabProps, type OpenThreadTarget } from './types';
import { Card, ErrorText, GhostButton, LoadingRow, SecondaryButton } from './workspaceUi';
import { projectErrorText } from './projectErrorText';
import { formatDue, isOverdue } from './tasks/taskText';

export function itemTab(item: ProjectItem) {
    return ({ chat: 'chats', task: 'tasks', document: 'documents', notebook: 'notebooks', meeting: 'meetings', file: 'knowledge' } as const)[item.type];
}
export function FileContent({ projectId, fileId, onClose }: { projectId: string; fileId: string; onClose: () => void }) {
    const { t } = useTranslation();
    const query = useProjectFileContent(projectId, fileId);
    const download = () => {
        if (!query.data?.available) return;
        const url = URL.createObjectURL(new Blob([query.data.content], { type: 'text/plain;charset=utf-8' }));
        const a = document.createElement('a'); a.href = url; a.download = `${query.data.file.name.replace(/[/\\]/g, '_')}.txt`; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return <section className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 space-y-3" aria-label={t('project_content.source_text', 'Text available to AI')}>
        <div className="flex items-center gap-2"><h3 className="font-semibold flex-1 break-all">{(!query.isError && query.data?.file.name) || t('project_content.source_text', 'Text available to AI')}</h3><SecondaryButton onClick={onClose} aria-label={t('project_content.close', 'Close')}><X className="w-4 h-4" /></SecondaryButton></div>
        {query.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
        {query.isError && <><ErrorText>{projectErrorText(t, query.error)}</ErrorText><SecondaryButton onClick={() => query.refetch()}>{t('project_home.retry', 'Try again')}</SecondaryButton></>}
        {!query.isError && query.data && <>
            <p className="text-xs text-[var(--text-secondary)]">{t('project_content.source_text', 'Text available to AI')} · {query.data.file.status}</p>
            {query.data.file.statusReason && <ErrorText>{query.data.file.statusReason}</ErrorText>}
            {query.data.available ? <><SecondaryButton onClick={download}>{t('project_content.download_text', 'Download text')}</SecondaryButton><pre className="whitespace-pre-wrap break-words text-sm max-h-[55vh] overflow-auto">{query.data.content}</pre></> : <p className="text-sm">{t('project_content.source_unavailable', 'No processed text is available for this file yet.')}</p>}
        </>}
    </section>;
}
export function ProjectPins({ projectId, onOpenTab, role, onOpenThread }: Pick<WorkspaceTabProps, 'projectId' | 'onOpenTab' | 'role'> & { onOpenThread?: (thread: OpenThreadTarget) => void }) {
    const { t } = useTranslation();
    const query = useProjectPins(projectId);
    const pin = useSetProjectPin(projectId);
    const canPin = canEditProject(role);
    return <Card title={t('project_home.pinned', 'Pinned for everyone')} testId="overview-pins">
        {query.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
        {(query.error || pin.error) && <ErrorText>{projectErrorText(t, query.error || pin.error)}</ErrorText>}
        {query.data?.items.length === 0 && <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{canPin
            ? t('project_home.pin_help', 'Use project search to pin important conversations, tasks and sources here.')
            : t('project_home.pin_none', 'Nothing is pinned yet.')}</p>}
        {!query.isError && query.data?.items.map(item => <div key={`${item.type}:${item.id}`} className="flex gap-2 items-center -mx-1.5">
            <button type="button" className="flex-1 min-w-0 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-tertiary)]" onClick={() => item.threadType ? onOpenThread?.({ id: item.id, type: item.threadType, agentId: item.agentId || null }) : onOpenTab?.(itemTab(item), item.id)}>
                <span className="block text-[12.5px] font-medium text-[var(--text-primary)] break-words">{item.title || t('project_home.untitled', 'Untitled')}</span>
                <span className="block text-[11px] text-[var(--text-tertiary)]">{t(`project_home.item.${item.type}`, item.type)}</span>
            </button>
            {canPin && <SecondaryButton disabled={pin.isPending} onClick={() => pin.mutate({ item, pinned: false })} aria-label={t('project_home.unpin', 'Unpin')}><X className="w-3 h-3" /></SecondaryButton>}
        </div>)}
    </Card>;
}
export function MyProjectTasks({ projectId, currentUser, onOpenTab }: Pick<WorkspaceTabProps, 'projectId' | 'currentUser' | 'onOpenTab'>) {
    const { t, locale } = useTranslation();
    const query = useProjectTasksQuery(projectId);
    const userId = currentUser?.id;
    const tasks = userId ? (query.data?.tasks || []).filter(task => task.status !== 'done' && task.assigneeIds.includes(userId)).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')) : [];
    return <Card
        title={t('project_home.my_tasks', 'My open tasks')}
        testId="overview-my-tasks"
        action={tasks.length > 0 ? <GhostButton onClick={() => onOpenTab?.('tasks')}>{t('project_home.overview.see_all', 'See all')}</GhostButton> : undefined}
    >
        {query.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
        {query.error && <ErrorText>{projectErrorText(t, query.error)}</ErrorText>}
        {!query.isPending && !query.error && tasks.length === 0 && <p className="m-0 text-[12px] text-[var(--text-tertiary)]">{t('project_home.no_my_tasks', 'No open tasks assigned to you.')}</p>}
        {tasks.length > 0 && <ul className="m-0 p-0 list-none -mx-1.5">
            {tasks.slice(0, 5).map(task => {
                const overdue = isOverdue(task.dueDate, task.status);
                return <li key={task.id}>
                    <button type="button" data-testid={`my-task-${task.id}`} className="w-full rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-[var(--bg-tertiary)]" onClick={() => onOpenTab?.('tasks', task.id)}>
                        <span className="block text-[12.5px] font-medium text-[var(--text-primary)] line-clamp-2">{task.title}</span>
                        {task.dueDate && <span className={`flex items-center gap-1 text-[11px] ${overdue ? 'text-[var(--error-ink)] font-medium' : 'text-[var(--text-tertiary)]'}`}>
                            <CalendarDays className="w-3 h-3" aria-hidden="true" />
                            {overdue
                                ? t('project_home.task_overdue', 'Overdue · {date}', { date: formatDue(task.dueDate, locale) })
                                : t('project_home.task_due', 'Due {date}', { date: formatDue(task.dueDate, locale) })}
                        </span>}
                    </button>
                </li>;
            })}
        </ul>}
        {tasks.length > 5 && <p className="m-0 mt-1 text-[11px] text-[var(--text-tertiary)]">{t('project_home.more_tasks', '{n} more in Tasks', { n: tasks.length - 5 })}</p>}
    </Card>;
}
