// The rail's rows and figures, in one place: the desktop rail and the phone
// bar both read from here, so they can never list different sections.
import {
    Activity, BookOpen, CheckSquare, FileText, House, MessagesSquare, Mic, NotebookPen, Settings, Users,
} from 'lucide-react';
import type React from 'react';
import { useProjectChatsQuery } from '../../../api/queries/projectChats';
import { useProjectFilesQuery } from '../../../api/queries/projectContent';
import { useProjectTasksQuery } from '../../../api/queries/projectTasks';
import {
    useProjectMembersQuery, useProjectQuery, useProjectResourcesQuery, useProjectThreadsQuery, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import { kindColorVar } from '../../shared/kindColors';
import { roleOfProject, type WorkspaceTabId } from './types';
import { useProjectUnread } from './useProjectUnread';

export type Glyph = React.ComponentType<{ className?: string; style?: React.CSSProperties; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;
export interface RailItem { id: WorkspaceTabId; label: string; Icon: Glyph; iconStyle: React.CSSProperties }
export interface RailGroupDef { id: 'collaborate' | 'content' | 'manage'; label: string; items: RailItem[] }
export type RailCounts = Partial<Record<WorkspaceTabId, number | null>>;

/** Sections this reader cannot use: Notebooks without notebooks, Tasks in a Studio Solution. */
export function hiddenTabsFor(project: Pick<Project, 'kind'> | null | undefined, notebooksEnabled: boolean): readonly WorkspaceTabId[] {
    const out: WorkspaceTabId[] = [];
    if (!notebooksEnabled) out.push('notebooks');
    if (project?.kind === 'solution') out.push('tasks');
    return out;
}

export function useRailGroups(hidden: readonly WorkspaceTabId[]): RailGroupDef[] {
    const { t } = useTranslation();
    const item = (id: WorkspaceTabId, label: string, Icon: Glyph, color: string): RailItem => ({ id, label, Icon, iconStyle: { color } });
    const groups: RailGroupDef[] = [
        { id: 'collaborate', label: t('project_home.rail.collaborate', 'Collaborate'), items: [
            item('overview', t('project_home.tab.overview', 'Overview'), House, 'var(--text-secondary)'),
            item('chats', t('project_home.tab.chats', 'Chats'), MessagesSquare, 'var(--accent-primary)'),
            item('tasks', t('project_home.tab.tasks', 'Tasks'), CheckSquare, 'var(--success, var(--accent-primary))'),
            item('meetings', t('project_home.tab.meetings', 'Meetings'), Mic, kindColorVar('meeting')),
        ] },
        { id: 'content', label: t('project_home.rail.content', 'Content'), items: [
            item('documents', t('project_home.tab.documents', 'Documents'), FileText, kindColorVar('document')),
            item('notebooks', t('project_home.tab.notebooks', 'Notebooks'), NotebookPen, 'var(--text-secondary)'),
            item('knowledge', t('project_home.tab.knowledge', 'Knowledge'), BookOpen, kindColorVar('kb')),
        ] },
        { id: 'manage', label: t('project_home.rail.manage', 'Manage'), items: [
            item('members', t('project_home.tab.members', 'Members'), Users, 'var(--text-secondary)'),
            item('activity', t('project_home.tab.activity', 'Activity'), Activity, 'var(--text-secondary)'),
            item('settings', t('project_home.tab.settings', 'Settings'), Settings, 'var(--text-secondary)'),
        ] },
    ];
    return hidden.length ? groups.map((g) => ({ ...g, items: g.items.filter((i) => !hidden.includes(i.id)) })) : groups;
}

const lengthOf = (v: unknown): number | null => (Array.isArray(v) ? v.length : null);

/** Rail counts. A count that is not known yet stays absent — never a guessed 0. */
export function useRailCounts(projectId: string): RailCounts {
    const resources = useProjectResourcesQuery(projectId);
    const threads = useProjectThreadsQuery(projectId);
    const teamChats = useProjectChatsQuery(projectId);
    const files = useProjectFilesQuery(projectId);
    const members = useProjectMembersQuery(projectId);
    const tasks = useProjectTasksQuery(projectId);
    const kbs = lengthOf(resources.data?.knowledgeBases);
    return {
        chats: teamChats.data && threads.data ? teamChats.data.chats.length + threads.data.length : null,
        tasks: tasks.data ? tasks.data.tasks.filter(x => x.status !== 'done').length : null,
        documents: lengthOf(resources.data?.documents),
        notebooks: lengthOf(resources.data?.notebooks),
        meetings: lengthOf(resources.data?.meetings),
        knowledge: files.data && kbs !== null ? files.data.files.length + kbs : null,
        members: members.data ? new Set([members.data.ownerId, ...members.data.members.filter(m => m.sharedWithType === 'user').map(m => m.sharedWithId)]).size : null,
    };
}

export function useProjectRailData(projectId: string, notebooksEnabled: boolean): {
    project: Project | null; role: ProjectRole | null; groups: RailGroupDef[]; counts: RailCounts;
    unread: Partial<Record<WorkspaceTabId, boolean>>; loading: boolean; error: Error | null;
} {
    const query = useProjectQuery(projectId);
    const project = query.data ?? null;
    const groups = useRailGroups(hiddenTabsFor(project, notebooksEnabled));
    const counts = useRailCounts(projectId);
    const unread = useProjectUnread(projectId).tabs;
    return { project, role: project ? roleOfProject(project) : null, groups, counts, unread, loading: query.isPending, error: query.isError ? query.error : null };
}
