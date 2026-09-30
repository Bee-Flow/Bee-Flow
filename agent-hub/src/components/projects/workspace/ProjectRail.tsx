// The project's own rail: who and what this project is at the top (tile,
// name, the people in it with a dot for who is here now), then one row per
// section. Studio's RailRow recipe: the active row is a raised card, counts
// are absent until known (never a guessed 0). Below 1180px the rail folds to
// its icons; the labels stay available to screen readers.

import {
    Activity, ArrowLeft, BookOpen, FileText, House, MessagesSquare, Mic, NotebookPen, Settings, Users,
} from 'lucide-react';
import React from 'react';
import { useProjectMembersQuery, type Project, type ProjectRole } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import { kindColorVar } from '../../shared/kindColors';
import { useProjectLive } from './ProjectLiveContext';
import { projectIcon, projectTileStyle } from './projectVisuals';
import type { WorkspaceTabId } from './types';
import { Avatar } from './workspaceUi';

type Glyph = React.ComponentType<{ className?: string; style?: React.CSSProperties; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;

export type RailCounts = Partial<Record<WorkspaceTabId, number | null>>;

interface RailItem { id: WorkspaceTabId; label: string; Icon: Glyph; iconStyle: React.CSSProperties }

function useRailItems(): { top: RailItem[]; work: RailItem[]; project: RailItem[] } {
    const { t } = useTranslation();
    return {
        top: [{ id: 'overview', label: t('project_home.tab.overview', 'Overview'), Icon: House, iconStyle: { color: 'var(--text-secondary)' } }],
        work: [
            { id: 'chats', label: t('project_home.tab.chats', 'Chats'), Icon: MessagesSquare, iconStyle: { color: 'var(--accent-primary)' } },
            { id: 'documents', label: t('project_home.tab.documents', 'Documents'), Icon: FileText, iconStyle: { color: kindColorVar('document') } },
            { id: 'notebooks', label: t('project_home.tab.notebooks', 'Notebooks'), Icon: NotebookPen, iconStyle: { color: 'var(--text-secondary)' } },
            { id: 'meetings', label: t('project_home.tab.meetings', 'Meetings'), Icon: Mic, iconStyle: { color: kindColorVar('meeting') } },
            { id: 'knowledge', label: t('project_home.tab.knowledge', 'Knowledge'), Icon: BookOpen, iconStyle: { color: kindColorVar('kb') } },
        ],
        project: [
            { id: 'members', label: t('project_home.tab.members', 'Members'), Icon: Users, iconStyle: { color: 'var(--text-secondary)' } },
            { id: 'activity', label: t('project_home.tab.activity', 'Activity'), Icon: Activity, iconStyle: { color: 'var(--text-secondary)' } },
            { id: 'settings', label: t('project_home.tab.settings', 'Settings'), Icon: Settings, iconStyle: { color: 'var(--text-secondary)' } },
        ],
    };
}

/** Something in this section changed that the reader has not seen: a dot, never a number. */
function UnreadDot({ label, testId }: { label: string; testId: string }) {
    return (
        <span
            className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--accent-primary)] max-[1180px]:absolute max-[1180px]:top-1.5 max-[1180px]:right-2"
            role="img"
            aria-label={label}
            data-testid={testId}
        />
    );
}

function RailRow({ item, active, count, unread, onSelect }: {
    item: RailItem;
    active: boolean;
    count?: number | null;
    unread?: boolean;
    onSelect: (id: WorkspaceTabId) => void;
}) {
    const { t } = useTranslation();
    const { Icon } = item;
    return (
        <button
            type="button"
            onClick={() => onSelect(item.id)}
            aria-current={active ? 'page' : undefined}
            title={item.label}
            data-testid={`project-rail-${item.id}`}
            className={`relative w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-all duration-150 max-[1180px]:justify-center max-[1180px]:px-0 ${
                active ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--item-hover-bg)]'
            }`}
        >
            <Icon className="w-4 h-4 flex-shrink-0" style={item.iconStyle} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
            <span className={`flex-1 min-w-0 truncate text-[13px] leading-tight text-[var(--text-primary)] max-[1180px]:sr-only ${active ? 'font-semibold' : 'font-medium'}`}>
                {item.label}
            </span>
            {unread && !active && <UnreadDot label={t('project_home.rail.unread', 'New changes')} testId={`project-rail-${item.id}-unread`} />}
            {typeof count === 'number' && Number.isFinite(count) && (
                <span className="flex-shrink-0 text-[12px] tabular-nums text-[var(--text-tertiary)] max-[1180px]:hidden" data-testid={`project-rail-${item.id}-count`}>
                    {count}
                </span>
            )}
        </button>
    );
}

function RailGroup({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div className="mt-3" role="group" aria-label={label}>
            <p className="px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)] m-0 max-[1180px]:sr-only">{label}</p>
            <div className="flex flex-col gap-0.5">{children}</div>
        </div>
    );
}

/** The people in the project, owner first, with a presence dot. */
function MemberStack({ projectId, currentUserId }: { projectId: string; currentUserId: string | null | undefined }) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    const { online } = useProjectLive();
    const data = members.data;
    if (!data) return null;
    const people = [data.ownerId, ...data.members.filter((m) => m.sharedWithType === 'user').map((m) => m.sharedWithId)];
    const extra = people.length > 5 ? people.length - 5 : 0;
    const here = online.filter((id) => id !== currentUserId).length;
    return (
        <div className="flex items-center gap-2 mt-2 max-[1180px]:hidden" data-testid="project-rail-people">
            <div className="flex -space-x-1.5">
                {people.slice(0, 5).map((id) => (
                    <Avatar
                        key={id}
                        size="sm"
                        name={data.people[id]?.name}
                        online={id === currentUserId || online.includes(id)}
                        onlineLabel={t('project_home.online', 'Online')}
                    />
                ))}
            </div>
            <span className="text-[11px] text-[var(--text-tertiary)]">
                {extra > 0 && `+${extra} · `}
                {here > 0
                    ? t('project_home.rail.here_now', '{n} here now', { n: here })
                    : t('project_home.rail.just_you', 'Only you here now')}
            </span>
        </div>
    );
}

export default function ProjectRail({ project, role, activeTab, counts, unread = {}, onSelect, onBack, currentUserId, hidden }: {
    project: Project;
    role: ProjectRole;
    activeTab: WorkspaceTabId;
    counts: RailCounts;
    /** Sections with changes the reader has not seen (useProjectUnread). */
    unread?: Partial<Record<WorkspaceTabId, boolean>>;
    onSelect: (tab: WorkspaceTabId) => void;
    onBack: () => void;
    currentUserId: string | null | undefined;
    /** Sections this reader cannot use (Notebooks without notebooks), left out of the rail. */
    hidden?: readonly WorkspaceTabId[];
}) {
    const { t } = useTranslation();
    const items = useRailItems();
    const shown = (list: RailItem[]) => (hidden?.length ? list.filter((item) => !hidden.includes(item.id)) : list);
    const row = (item: RailItem) => (
        <RailRow key={item.id} item={item} active={activeTab === item.id} count={counts[item.id]} unread={!!unread[item.id]} onSelect={onSelect} />
    );
    const roleText = role === 'owner'
        ? t('project_home.role.owner', 'Owner')
        : role === 'editor' ? t('project_home.role.editor', 'Editor') : t('project_home.role.viewer', 'Viewer');

    return (
        <nav
            aria-label={t('project_home.rail.label', 'Project sections')}
            className="h-full w-60 max-[1180px]:w-14 flex flex-col flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)]"
            data-surface="subtle"
            data-static=""
            data-testid="project-rail"
        >
            <div className="px-2 pt-2">
                <button
                    type="button"
                    onClick={onBack}
                    title={t('project_home.all_projects', 'All projects')}
                    className="inline-flex items-center gap-1.5 px-1.5 py-1 rounded-lg text-[12px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
                    data-testid="project-rail-back"
                >
                    <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
                    <span className="max-[1180px]:sr-only">{t('project_home.all_projects', 'All projects')}</span>
                </button>
            </div>
            <div className="px-3 pt-2 pb-1 max-[1180px]:px-2">
                <div className="flex items-center gap-2.5 max-[1180px]:justify-center">
                    <span style={projectTileStyle(project.color, 32)} aria-hidden="true">{projectIcon(project.icon)}</span>
                    <div className="min-w-0 max-[1180px]:sr-only">
                        <p className="text-[14px] font-semibold text-[var(--text-primary)] truncate m-0" data-testid="project-rail-name">{project.name}</p>
                        <p className="text-[11px] text-[var(--text-tertiary)] m-0">{roleText}</p>
                    </div>
                </div>
                <MemberStack projectId={project.id} currentUserId={currentUserId} />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 pt-2 flex flex-col">
                <div className="flex flex-col gap-0.5">{shown(items.top).map(row)}</div>
                <RailGroup label={t('project_home.rail.work', 'Work')}>{shown(items.work).map(row)}</RailGroup>
                <RailGroup label={t('project_home.rail.project', 'Project')}>{shown(items.project).map(row)}</RailGroup>
            </div>
        </nav>
    );
}
