import React, { useEffect, useState } from 'react';
import { BookOpen, Pin, Search, X } from 'lucide-react';
import { ITEM_TYPES, useProjectFileContent, useProjectPins, useProjectSearch, useSetProjectPin, type ProjectItem } from '../../../api/queries/projectDiscovery';
import { useProjectTasksQuery } from '../../../api/queries/projectTasks';
import useTranslation from '../../../hooks/useTranslation';
import { canEditProject, type WorkspaceTabProps, type OpenThreadTarget } from './types';
import { Card, ErrorText, INPUT_CLASS, LoadingRow, SecondaryButton, SELECT_CLASS } from './workspaceUi';
import { projectErrorText } from './projectErrorText';
import { todayKey } from './tasks/taskText';

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
    return <Card title={t('project_home.pinned', 'Pinned for everyone')}>
        {query.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
        {(query.error || pin.error) && <ErrorText>{projectErrorText(t, query.error || pin.error)}</ErrorText>}
        {query.data?.items.length === 0 && <p className="text-xs text-[var(--text-secondary)]">{t('project_home.pin_help', 'Use project search to pin important conversations, tasks and sources here.')}</p>}
        {!query.isError && query.data?.items.map(item => <div key={`${item.type}:${item.id}`} className="flex gap-2 items-center py-1">
            <button className="text-sm text-left flex-1 hover:underline break-words" onClick={() => item.threadType ? onOpenThread?.({ id: item.id, type: item.threadType, agentId: item.agentId || null }) : onOpenTab?.(itemTab(item), item.id)}>{item.title || t('project_home.untitled', 'Untitled')}</button>
            {canEditProject(role) && <SecondaryButton disabled={pin.isPending} onClick={() => pin.mutate({ item, pinned: false })} aria-label={t('project_home.unpin', 'Unpin')}><X className="w-3 h-3" /></SecondaryButton>}
        </div>)}
    </Card>;
}
export function MyProjectTasks({ projectId, currentUser, onOpenTab }: Pick<WorkspaceTabProps, 'projectId' | 'currentUser' | 'onOpenTab'>) {
    const { t } = useTranslation();
    const query = useProjectTasksQuery(projectId);
    const tasks = (query.data?.tasks || []).filter(task => task.status !== 'done' && task.assigneeIds.includes(currentUser?.id || '')).sort((a,b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
    return <Card title={t('project_home.my_tasks', 'My open tasks')}>
        {query.error && <ErrorText>{projectErrorText(t, query.error)}</ErrorText>}
        {!query.isPending && !query.error && tasks.length === 0 && <p className="text-xs text-[var(--text-secondary)]">{t('project_home.no_my_tasks', 'No open tasks assigned to you.')}</p>}
        {tasks.slice(0, 5).map(task => <button key={task.id} className="block text-left text-sm py-1 w-full hover:underline" onClick={() => onOpenTab?.('tasks', task.id)}>{task.title}<span className={`block text-xs ${task.dueDate && task.dueDate < todayKey() ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'}`}>{task.dueDate}</span></button>)}
        {tasks.length > 5 && <SecondaryButton onClick={() => onOpenTab?.('tasks')}>{t('project_home.tab.tasks', 'Tasks')} ({tasks.length})</SecondaryButton>}
    </Card>;
}
export default function ProjectDiscovery(props: Pick<WorkspaceTabProps, 'projectId' | 'project' | 'role' | 'onOpenTab'> & { onOpenThread?: (thread: OpenThreadTarget) => void }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    const [type, setType] = useState('');
    useEffect(() => { const timer = setTimeout(() => setQ(search), 250); return () => clearTimeout(timer); }, [search]);
    const results = useProjectSearch(props.projectId, q, type, open);
    const pins = useProjectPins(props.projectId);
    const pin = useSetProjectPin(props.projectId);
    return <div className="border-b border-[var(--border-subtle)] px-3 py-2 bg-[var(--bg-primary)] text-[var(--text-primary)]">
        <div className="flex gap-2">
            <SecondaryButton onClick={() => setOpen(!open)} aria-expanded={open}><Search className="w-4 h-4" />{t('project_home.search_project', 'Search this project')}</SecondaryButton>
            <SecondaryButton onClick={() => props.onOpenTab?.('knowledge')}><BookOpen className="w-4 h-4" />{t('project_home.ai_context', 'AI context')}</SecondaryButton>
        </div>
        {open && <section className="py-3 space-y-2" aria-label={t('project_home.search_project', 'Search this project')}>
            <div className="flex gap-2"><input autoFocus type="search" className={INPUT_CLASS} value={search} onChange={e => setSearch(e.target.value)} placeholder={t('project_home.search_project', 'Search this project')} aria-label={t('project_home.search_project', 'Search this project')} /><select className={SELECT_CLASS} value={type} onChange={e => setType(e.target.value)} aria-label={t('project_content.type', 'Type')}><option value="">{t('project_home.all_types', 'All types')}</option>{ITEM_TYPES.map(type => <option key={type} value={type}>{t(`project_home.item.${type}`, type)}</option>)}</select></div>
            <p className="text-xs text-[var(--text-secondary)]">{t('project_home.search_scope', 'Search titles, file names and task descriptions. Message contents are not searched.')}</p>
            {results.isPending && <LoadingRow label={t('project_home.loading', 'Loading…')} />}
            {(results.error || pin.error) && <ErrorText>{projectErrorText(t, results.error || pin.error)}</ErrorText>}
            <div className="max-h-[40vh] overflow-auto">
                {!results.isError && results.data?.pages.flatMap(p => p?.items || []).map(item => {
                    const pinned = pins.data?.items.some(p => p.type === item.type && p.id === item.id) || false;
                    return <div key={`${item.type}:${item.id}`} className="flex items-center gap-2 py-2 border-b border-[var(--border-subtle)]">
                        <button className="text-left flex-1 min-w-0 text-sm hover:underline" onClick={() => { if (item.threadType) props.onOpenThread?.({ id: item.id, type: item.threadType, agentId: item.agentId || null }); else props.onOpenTab?.(itemTab(item), item.id); setOpen(false); }}>{item.title || t('project_home.untitled', 'Untitled')}<span className="block text-xs text-[var(--text-secondary)]">{t(`project_home.item.${item.type}`, item.type)}</span></button>
                        {canEditProject(props.role) && <SecondaryButton disabled={pin.isPending || !pins.data} aria-pressed={pinned} onClick={() => pin.mutate({ item, pinned: !pinned })} aria-label={pinned ? t('project_home.unpin', 'Unpin') : t('project_home.pin', 'Pin for everyone')}><Pin className={`w-4 h-4 ${pinned ? 'fill-current' : ''}`} /></SecondaryButton>}
                    </div>;
                })}
                {results.data?.pages[0]?.items.length === 0 && <p className="text-sm">{t('project_content.no_matches', 'Nothing matches your search.')}</p>}
                {results.hasNextPage && <SecondaryButton busy={results.isFetchingNextPage} onClick={() => results.fetchNextPage()}>{t('project_home.activity.load_more', 'Load more')}</SecondaryButton>}
            </div>
        </section>}
    </div>;
}
