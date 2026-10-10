// Projects: the list of collaborative workspaces the user is in.
//
// Studio's list-page look — one section header (title, count, primary
// action), a toolbar, a card grid — and an empty state that explains what a
// project is for, because a blank page with a "New" button does not.

import { Archive, FolderOpen, Plus, Search, Users } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { Project, ProjectRole } from '../../api/queries/projects';
import useRelativeTime from '../../hooks/useRelativeTime';
import useTranslation from '../../hooks/useTranslation';
import SegmentedControl from '../shared/SegmentedControl';
import { projectIcon, projectTileStyle } from './workspace/projectVisuals';
import { FilterPills, RequireTier, StudioSectionHeader } from './workspace/studioParts';
import type { AppUserLike } from './workspace/types';
import { ErrorText, INPUT_CLASS, PrimaryButton, SecondaryButton, Skeleton } from './workspace/workspaceUi';

export interface ProjectsHomeProps {
    projects: Project[];
    /** Archived projects (`archivedAt` set), for the "Archived" pill. The main list never holds them. */
    archivedProjects?: Project[];
    loading?: boolean;
    error?: string | null;
    user: AppUserLike | null;
    onSelectProject: (project: Project) => void;
    onCreateProject: () => void;
    onClose: () => void;
}

type Filter = 'all' | 'mine' | 'shared' | 'archived';
type Sort = 'recent' | 'az';

/** The caller's role in a list row. Unknown stays unknown: it is neither "mine" nor "shared". */
export function listRole(project: Project, userId: string | undefined): ProjectRole | null {
    const role = project.permission || project.role;
    if (role === 'owner' || role === 'editor' || role === 'viewer') return role;
    return userId && project.ownerId === userId ? 'owner' : null;
}

function stamp(p: Project): number {
    const n = Date.parse(p.updatedAt || p.createdAt || '');
    return Number.isNaN(n) ? 0 : n;
}

function useVisibleProjects(projects: Project[], userId: string | undefined, query: string, filter: Filter, sort: Sort) {
    return useMemo(() => {
        const q = query.trim().toLowerCase();
        const rows = projects.filter((p) => {
            const role = listRole(p, userId);
            if (filter === 'archived') return !q || `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(q);
            if (filter === 'mine' && role !== 'owner') return false;
            if (filter === 'shared' && (role === null || role === 'owner')) return false;
            return !q || `${p.name || ''} ${p.description || ''}`.toLowerCase().includes(q);
        });
        return rows.sort((a, b) => (sort === 'az'
            ? (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
            : stamp(b) - stamp(a)));
    }, [projects, userId, query, filter, sort]);
}

function RoleBadge({ role }: { role: ProjectRole | null }) {
    const { t } = useTranslation();
    if (!role) return null;
    if (role === 'owner') {
        return <span className="text-[11px] text-[var(--text-tertiary)]">{t('project_home.role.owner', 'Owner')}</span>;
    }
    return (
        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium bg-[var(--item-active-bg)] text-[var(--text-primary)]">
            <Users className="w-3 h-3" aria-hidden="true" />
            {role === 'editor' ? t('project_home.list.shared_editor', 'Shared · can edit') : t('project_home.list.shared_viewer', 'Shared · can view')}
        </span>
    );
}

function ProjectCard({ project, role, onOpen }: { project: Project; role: ProjectRole | null; onOpen: () => void }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    return (
        <button
            type="button"
            onClick={onOpen}
            data-testid={`project-card-${project.id}`}
            className="flex flex-col gap-2.5 p-3.5 rounded-xl text-left border border-[var(--border-default)] bg-[var(--bg-card)] w-full transition-colors hover:border-[var(--accent-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
        >
            <div className="flex items-center gap-2.5 min-w-0 w-full">
                <span style={projectTileStyle(project.color, 36)} aria-hidden="true">{projectIcon(project.icon)}</span>
                <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-[var(--text-primary)] truncate">{project.name || t('project_home.untitled', 'Untitled')}</span>
                    {project.updatedAt && (
                        <span className="block text-[11px] text-[var(--text-tertiary)]">
                            {t('project_home.list.updated', 'Updated {when}', { when: rel(project.updatedAt) })}
                        </span>
                    )}
                </span>
            </div>
            <span className={`line-clamp-2 text-[12.5px] leading-snug min-h-[2.5em] ${project.description ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)] italic'}`}>
                {project.description || t('project_home.list.no_description', 'No description')}
            </span>
            <span className="flex items-center gap-2 flex-wrap">
                <RoleBadge role={role} />
                {project.archivedAt && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium border border-[var(--border-default)] text-[var(--text-secondary)]" data-testid={`project-archived-chip-${project.id}`}>
                        <Archive className="w-3 h-3" aria-hidden="true" />
                        {t('project_home.archived.chip', 'Archived')}
                    </span>
                )}
            </span>
        </button>
    );
}

function FirstProject({ onCreate }: { onCreate: () => void }) {
    const { t } = useTranslation();
    const points = [
        t('project_home.list.point_chat', 'Chat with the AI and with each other, in chats everyone in the project can follow.'),
        t('project_home.list.point_content', 'Keep documents, notebooks and meeting notes together.'),
        t('project_home.list.point_knowledge', 'Give the AI instructions and files that apply to every chat in the project.'),
    ];
    return (
        <div className="flex flex-col items-center text-center gap-3 py-12 max-w-md mx-auto" data-testid="projects-empty">
            <span className="w-12 h-12 grid place-items-center rounded-xl bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <FolderOpen className="w-6 h-6" aria-hidden="true" />
            </span>
            <h2 className="text-[15px] font-semibold text-[var(--text-primary)] m-0">{t('project_home.list.empty_title', 'Work together in a project')}</h2>
            <ul className="text-[13px] text-[var(--text-secondary)] text-left space-y-1.5 list-disc pl-5 m-0">
                {points.map((p) => <li key={p}>{p}</li>)}
            </ul>
            <PrimaryButton onClick={onCreate} data-testid="projects-empty-create">
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                {t('project_home.list.create_first', 'Create your first project')}
            </PrimaryButton>
        </div>
    );
}

function Toolbar({ query, setQuery, filter, setFilter, sort, setSort, counts }: {
    query: string; setQuery: (v: string) => void;
    filter: Filter; setFilter: (v: Filter) => void;
    sort: Sort; setSort: (v: Sort) => void;
    counts: Record<Filter, number>;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3 flex-wrap">
            <label className="relative block w-64 max-w-full">
                <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)]" aria-hidden="true" />
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('project_home.list.search', 'Search projects')}
                    aria-label={t('project_home.list.search', 'Search projects')}
                    className={`${INPUT_CLASS} pl-8 py-1.5 text-xs`}
                    data-testid="projects-search"
                />
            </label>
            <FilterPills
                value={filter}
                onChange={setFilter}
                ariaLabel={t('project_home.list.filter', 'Show')}
                testId="projects-filter"
                options={[
                    { value: 'all', label: t('project_home.list.filter_all', 'All'), count: counts.all },
                    { value: 'mine', label: t('project_home.list.filter_mine', 'Mine'), count: counts.mine },
                    { value: 'shared', label: t('project_home.list.filter_shared', 'Shared with me'), count: counts.shared },
                    ...(counts.archived > 0 || filter === 'archived'
                        ? [{ value: 'archived' as const, label: t('project_home.list.filter_archived', 'Archived'), count: counts.archived }]
                        : []),
                ]}
            />
            <div className="flex-1" />
            <SegmentedControl
                size="sm"
                value={sort}
                onChange={setSort}
                ariaLabel={t('project_home.list.sort', 'Sort')}
                options={[
                    { value: 'recent', label: t('project_home.list.sort_recent', 'Recent') },
                    { value: 'az', label: t('project_home.list.sort_az', 'A–Z') },
                ]}
            />
        </div>
    );
}

function NoMatches({ filter, query, onClear }: { filter: Filter; query: string; onClear: () => void }) {
    const { t } = useTranslation();
    let text = t('project_home.list.no_match', 'No projects match “{q}”.', { q: query.trim() });
    if (!query.trim()) {
        text = filter === 'archived'
            ? t('project_home.list.none_archived', 'No archived projects.')
            : filter === 'shared'
            ? t('project_home.list.none_shared', 'Nobody has shared a project with you yet.')
            : t('project_home.list.none_mine', 'You do not own any projects yet.');
    }
    return (
        <div className="px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)] flex items-center justify-between gap-3" data-testid="projects-no-match">
            <span>{text}</span>
            <SecondaryButton onClick={onClear}>{t('project_home.list.show_all', 'Show all projects')}</SecondaryButton>
        </div>
    );
}

function ProjectsHomeInner({ projects, archivedProjects, loading, error, user, onSelectProject, onCreateProject, onClose }: ProjectsHomeProps) {
    const { t } = useTranslation();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<Filter>('all');
    const [sort, setSort] = useState<Sort>('recent');
    const list = Array.isArray(projects) ? projects : [];
    const archivedList = useMemo(() => (Array.isArray(archivedProjects) ? archivedProjects : []).filter((p) => !!p.archivedAt), [archivedProjects]);
    const visible = useVisibleProjects(filter === 'archived' ? archivedList : list, user?.id, query, filter, sort);
    const counts = useMemo(() => ({
        all: list.length,
        archived: archivedList.length,
        mine: list.filter((p) => listRole(p, user?.id) === 'owner').length,
        shared: list.filter((p) => { const r = listRole(p, user?.id); return r !== null && r !== 'owner'; }).length,
    }), [list, archivedList, user?.id]);

    let body: React.ReactNode;
    if (loading && list.length === 0) body = <Skeleton rows={3} variant="cards" label={t('project_home.loading', 'Loading…')} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3" barClassName="!h-32" />;
    else if (error && list.length === 0) body = <ErrorText testId="projects-error">{t('project_home.list.load_failed', 'Could not load your projects: {error}', { error })}</ErrorText>;
    else if (list.length === 0) body = <FirstProject onCreate={onCreateProject} />;
    else if (visible.length === 0) body = <NoMatches filter={filter} query={query} onClear={() => { setQuery(''); setFilter('all'); }} />;
    else body = <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">{visible.map((p) => <ProjectCard key={p.id} project={p} role={listRole(p, user?.id)} onOpen={() => onSelectProject(p)} />)}</div>;

    return (
        <div className="h-full flex flex-col min-h-0 bg-[var(--bg-primary)]" data-testid="projects-home">
            <StudioSectionHeader
                icon={FolderOpen}
                title={t('project_home.list.title', 'Projects')}
                statusChip={loading && list.length === 0 ? null : String(list.length)}
                onBack={onClose}
                backLabel={t('project_home.list.back', 'Back to chat')}
                primary={(
                    <PrimaryButton onClick={onCreateProject} data-testid="projects-create">
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('project_home.list.new', 'New project')}
                    </PrimaryButton>
                )}
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
                    {list.length > 0 && <Toolbar query={query} setQuery={setQuery} filter={filter} setFilter={setFilter} sort={sort} setSort={setSort} counts={counts} />}
                    {body}
                </div>
            </div>
        </div>
    );
}

/** Licence-gated: without the `projects` feature the upgrade panel shows instead. */
export default function ProjectsHome(props: ProjectsHomeProps) {
    return (
        <RequireTier feature="projects">
            <ProjectsHomeInner {...props} />
        </RequireTier>
    );
}
