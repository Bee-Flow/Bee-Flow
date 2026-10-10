// The project's own rail, in the Studio recipe: head row (back, tile, name as a
// project switcher), a search pill, three groups of sections, the people in the
// project, then the account footer. The active row is a raised card, counts are
// absent until known (never a guessed 0). Below 1280px the rail folds to its
// icons; the labels stay available to screen readers.

import { ArrowLeft, Search } from 'lucide-react';
import React from 'react';
import { useProjectMembersQuery, type Project, type ProjectRole } from '../../../api/queries/projects';
import useTranslation from '../../../hooks/useTranslation';
import useViewport from '../../../hooks/useViewport';
import { useProjectLive } from './ProjectLiveContext';
import ProjectSwitcherMenu from './ProjectSwitcherMenu';
import { normalizeWorkspaceTab, type WorkspaceTabId } from './types';
import { useProjectRailData, type RailItem } from './useProjectRailData';
import { Avatar } from './workspaceUi';

export interface ProjectRailProps {
    projectId: string;
    /** null while the URL has no tab (= overview). */
    activeTab: WorkspaceTabId | null;
    onSelectTab: (tab: WorkspaceTabId) => void;
    /** "All projects". */
    onBack: () => void;
    /** The switcher. */
    onOpenProject: (projectId: string) => void;
    onOpenSearch: () => void;
    /** For the switcher. */
    projects: Project[];
    currentUserId: string | null | undefined;
    notebooksEnabled: boolean;
    /** Studio's footer contract: the account row with Sidebar's menu state. */
    footer: React.ReactNode;
}

/** Something in this section changed that the reader has not seen: a dot, never a number. */
function UnreadDot({ label, testId, folded }: { label: string; testId: string; folded: boolean }) {
    return (
        <span
            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--accent-primary)] ${folded ? 'absolute top-1.5 right-2' : ''}`}
            role="img"
            aria-label={label}
            data-testid={testId}
        />
    );
}

function RailRow({ item, active, count, unread, folded, onSelect }: {
    item: RailItem;
    active: boolean;
    count?: number | null;
    unread?: boolean;
    folded: boolean;
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
            className={`relative w-full flex items-center gap-2.5 py-2 rounded-lg text-left transition-all duration-150 ${folded ? 'justify-center px-0' : 'px-2.5'} ${
                active ? 'bg-[var(--bg-card)] shadow-sm' : 'hover:bg-[var(--item-hover-bg)]'
            }`}
        >
            <Icon className="w-4 h-4 flex-shrink-0" style={item.iconStyle} strokeWidth={active ? 2.25 : 1.75} aria-hidden="true" />
            <span className={`flex-1 min-w-0 truncate text-sm leading-tight text-[var(--text-primary)] ${folded ? 'sr-only' : ''} ${active ? 'font-semibold' : 'font-medium'}`}>
                {item.label}
            </span>
            {unread && !active && <UnreadDot label={t('project_home.rail.unread', 'New changes')} testId={`project-rail-${item.id}-unread`} folded={folded} />}
            {!folded && typeof count === 'number' && Number.isFinite(count) && (
                <span className="flex-shrink-0 text-xs tabular-nums text-[var(--text-tertiary)]" data-testid={`project-rail-${item.id}-count`}>
                    {count}
                </span>
            )}
        </button>
    );
}

/** The people in the project, owner first, with a presence dot. */
function MemberStack({ projectId, currentUserId, folded }: { projectId: string; currentUserId: string | null | undefined; folded: boolean }) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    const { online } = useProjectLive();
    const data = members.data;
    if (!data) return null;
    const people = [data.ownerId, ...data.members.filter((m) => m.sharedWithType === 'user').map((m) => m.sharedWithId)];
    const extra = people.length > 5 ? people.length - 5 : 0;
    const here = online.filter((id) => id !== currentUserId).length;
    const hereText = here > 0
        ? t('project_home.rail.here_now', '{n} here now', { n: here })
        : t('project_home.rail.just_you', 'Only you here now');
    return (
        <div
            className={`flex items-center gap-2 px-3 py-2 flex-shrink-0 border-t border-[var(--border-subtle)] ${folded ? 'justify-center' : ''}`}
            data-testid="project-rail-people"
        >
            <div className="flex -space-x-1.5" {...(folded ? { role: 'img', 'aria-label': hereText, title: hereText } : {})}>
                {people.slice(0, folded ? 1 : 5).map((id) => (
                    <Avatar
                        key={id}
                        size="sm"
                        name={data.people[id]?.name}
                        online={id === currentUserId || online.includes(id)}
                        onlineLabel={t('project_home.online', 'Online')}
                    />
                ))}
            </div>
            {!folded && (
                <span className="text-xs text-[var(--text-tertiary)]">
                    {extra > 0 && `+${extra} · `}
                    {hereText}
                </span>
            )}
        </div>
    );
}

function roleLabel(t: ReturnType<typeof useTranslation>['t'], role: ProjectRole): string {
    return role === 'owner'
        ? t('project_home.role.owner', 'Owner')
        : role === 'editor' ? t('project_home.role.editor', 'Editor') : t('project_home.role.viewer', 'Viewer');
}

export default function ProjectRail({
    projectId, activeTab, onSelectTab, onBack, onOpenProject, onOpenSearch, projects, currentUserId, notebooksEnabled, footer,
}: ProjectRailProps) {
    const { t } = useTranslation();
    const { isDesktop } = useViewport();
    const folded = !isDesktop; // < 1280px: icons only
    const data = useProjectRailData(projectId, notebooksEnabled);
    const tab = normalizeWorkspaceTab(activeTab);
    // Project unavailable (404): only the way out. Still loading: a quiet placeholder.
    const bare = !data.project;

    return (
        <nav
            aria-label={t('project_home.rail.label', 'Project sections')}
            className={`h-full ${folded ? 'w-16' : 'w-60'} flex flex-col flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)]`}
            data-surface="subtle"
            data-static=""
            data-folded={folded ? 'true' : undefined}
            data-testid="project-rail"
        >
            <div className={`flex items-center gap-2 px-2 flex-shrink-0 ${folded ? 'flex-col justify-center py-2' : 'h-14'}`}>
                <button
                    type="button"
                    onClick={onBack}
                    title={t('project_home.all_projects', 'All projects')}
                    aria-label={t('project_home.all_projects', 'All projects')}
                    className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
                    data-testid="project-rail-back"
                >
                    <ArrowLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                {data.project && (
                    <ProjectSwitcherMenu current={data.project} projects={projects} onOpenProject={onOpenProject} onBack={onBack} folded={folded} />
                )}
            </div>
            {!bare && !folded && data.role && (
                <p className="px-3 -mt-2 mb-1 text-xs text-[var(--text-tertiary)] m-0">{roleLabel(t, data.role)}</p>
            )}
            {!bare && <div className="px-2 pb-2 flex-shrink-0">
                <button
                    type="button"
                    onClick={onOpenSearch}
                    data-testid="project-rail-search"
                    aria-label={t('project_home.search_project', 'Search this project')}
                    title={t('project_home.search_project', 'Search this project')}
                    className={`w-full flex items-center gap-2 ${folded ? 'justify-center' : 'px-2.5'} h-9 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-primary)] text-left hover:border-[var(--border-default)]`}
                >
                    <Search className="w-3.5 h-3.5 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {!folded && (
                        <span className="flex-1 min-w-0 truncate text-xs text-[var(--text-tertiary)]">{t('project_home.rail.search', 'Search this project…')}</span>
                    )}
                </button>
            </div>}
            {bare ? (
                <div className="flex-1 min-h-0 px-3 py-4" aria-busy={data.loading || undefined} data-testid="project-rail-placeholder" />
            ) : (
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 pb-2 flex flex-col">
                {data.groups.map((g) => (
                    <div key={g.id} className="mt-3" role="group" aria-label={g.label}>
                        <p className={`px-2.5 pb-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)] m-0 ${folded ? 'sr-only' : ''}`}>{g.label}</p>
                        <div className="flex flex-col gap-0.5">
                            {g.items.map((item) => (
                                <RailRow
                                    key={item.id}
                                    item={item}
                                    active={tab === item.id}
                                    count={data.counts[item.id]}
                                    unread={!!data.unread[item.id]}
                                    folded={folded}
                                    onSelect={onSelectTab}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
            )}
            {!bare && data.project && <MemberStack projectId={projectId} currentUserId={currentUserId} folded={folded} />}
            {footer}
        </nav>
    );
}
