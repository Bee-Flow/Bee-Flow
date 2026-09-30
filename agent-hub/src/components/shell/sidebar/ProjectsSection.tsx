import { ChevronDown, FolderOpen, Plus } from 'lucide-react';
import React from 'react';
import { ACCENT_BAR, ROW, ROW_ACTIVE, ROW_IDLE, SECTION_HDR, SECTION_LBL, TEXT_ACTIVE, TEXT_IDLE } from './sidebarTokens';
import type { Project } from '../../../api/queries/projects';
import type { TranslateFn } from '../../../hooks/useTranslation';
import { projectIcon, projectTileStyle } from '../../projects/workspace/projectVisuals';

/* ── Projects group: the collaborative project workspaces you belong to.

   Only workspaces are listed (Studio Solutions have their own home in
   Studio). A row does two things at once: it opens the project's home page and
   makes it the context for the next chat, so what you start from there uses
   the project's instructions and knowledge. The hover "+" skips the home page
   and starts a new chat in the project straight away. Every piece of state
   stays in Sidebar and AgentHub and arrives here as props. ── */

export interface ProjectsSectionProps {
    t: TranslateFn;
    projects: Project[];
    projectsOpen: boolean;
    toggleProjects: () => void;
    activeProject?: Pick<Project, 'id'> | null;
    onCreateProject?: () => void;
    onOpenProject?: (project: Project) => void;
    onNewChatInProject?: (project: Project) => void;
    onBrowseProjects?: () => void;
}

/** Shared with me, as opposed to my own. A row without a role is treated as
 *  neither: it gets no badge, because unknown is not "someone else's". */
function isSharedWithMe(p: Project): boolean {
    const role = p.permission || p.role;
    return !!role && role !== 'owner';
}

export default function ProjectsSection({
    t, projects, projectsOpen, toggleProjects, activeProject,
    onCreateProject, onOpenProject, onNewChatInProject, onBrowseProjects,
}: ProjectsSectionProps) {
    return (
        <div className="mt-1">
            <div className={SECTION_HDR} onClick={toggleProjects}>
                <span className={SECTION_LBL}>{t('sidebar.projects', 'Projects')}</span>
                <div className="flex items-center gap-1">
                    <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onCreateProject?.(); }}
                        className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--accent-primary)] transition-colors"
                        title={t('sidebar.new_project', 'New Project')}
                        aria-label={t('sidebar.new_project', 'New Project')}
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                    <ChevronDown aria-hidden="true" className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-200 ${projectsOpen ? '' : '-rotate-90'}`} />
                </div>
            </div>

            {projectsOpen && (
                <div className="px-1.5 pb-1 space-y-0.5">
                    {projects.map((p) => {
                        const active = activeProject?.id === p.id;
                        const newChatLabel = t('sidebar.project_new_chat', 'New chat in {name}', { name: p.name });
                        return (
                            <div key={p.id} className={`${ROW} group/p pr-1 ${active ? ROW_ACTIVE : ROW_IDLE}`} data-testid={`sidebar-project-${p.id}`}>
                                {active && <div className={ACCENT_BAR} aria-hidden="true" />}
                                <button
                                    type="button"
                                    onClick={() => onOpenProject?.(p)}
                                    aria-current={active ? 'true' : undefined}
                                    className="flex items-center gap-2.5 flex-1 min-w-0 h-full text-left"
                                >
                                    <span aria-hidden="true" style={projectTileStyle(p.color, 20)}>
                                        {projectIcon(p.icon)}
                                    </span>
                                    <span className={`text-[13px] truncate flex-1 ${active ? TEXT_ACTIVE : TEXT_IDLE}`}>{p.name}</span>
                                    {isSharedWithMe(p) && (
                                        <span className="text-[9px] px-1 py-px rounded bg-[var(--bg-tertiary)] text-[var(--text-secondary)] font-medium flex-shrink-0">
                                            {t('sidebar.project_shared_badge', 'shared')}
                                        </span>
                                    )}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => onNewChatInProject?.(p)}
                                    className="opacity-0 group-hover/p:opacity-100 focus-visible:opacity-100 p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-all flex-shrink-0"
                                    title={newChatLabel}
                                    aria-label={newChatLabel}
                                >
                                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                                </button>
                            </div>
                        );
                    })}

                    <button
                        type="button"
                        onClick={() => onBrowseProjects?.()}
                        className={`${ROW} ${ROW_IDLE} text-[var(--text-tertiary)]`}
                    >
                        <FolderOpen className="w-4 h-4" aria-hidden="true" />
                        <span className="text-[13px]">{t('sidebar.all_projects', 'All projects')}</span>
                    </button>
                </div>
            )}
            <div className="mx-3 my-0.5 border-t border-[var(--border-subtle)]" />
        </div>
    );
}
