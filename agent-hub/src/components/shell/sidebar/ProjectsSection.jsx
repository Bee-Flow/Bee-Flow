import { ChevronDown, FolderOpen, Plus } from 'lucide-react';
import React from 'react';
import { ACCENT_BAR, ROW, ROW_ACTIVE, ROW_IDLE, SECTION_HDR, SECTION_LBL, TEXT_ACTIVE, TEXT_IDLE } from './sidebarTokens';

/* ── Projects group: header, project rows and the "All projects" entry point.
   Moved verbatim out of Sidebar's JSX; every piece of state stays in Sidebar
   and arrives here as props. ── */
const ProjectsSection = ({
    t, projects, projectsOpen, toggleProjects, activeProject,
    onCreateProject, onSelectProject, onEditProject, onBrowseProjects,
}) => (
                <div className="mt-1">
                    <div className={SECTION_HDR} onClick={toggleProjects}>
                        <span className={SECTION_LBL}>{t('sidebar.projects')}</span>
                        <div className="flex items-center gap-1">
                            <button
                                onClick={(e) => { e.stopPropagation(); onCreateProject?.(); }}
                                className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] hover:text-[var(--accent-primary)] transition-colors"
                                title="New Project"
                            >
                                <Plus className="w-3.5 h-3.5" />
                            </button>
                            <ChevronDown className={`w-3.5 h-3.5 text-[var(--text-tertiary)] transition-transform duration-200 ${projectsOpen ? '' : '-rotate-90'}`} />
                        </div>
                    </div>

                    {projectsOpen && (
                        <div className="px-1.5 pb-1 space-y-0.5">

                            {projects.map(p => {
                                const active = activeProject?.id === p.id;
                                return (
                                    <button
                                        key={p.id}
                                        onClick={() => onSelectProject?.(active ? null : p)}
                                        className={`${ROW} group/p ${active ? ROW_ACTIVE : ROW_IDLE}`}
                                    >
                                        {active && <div className={ACCENT_BAR} />}
                                        <div className="w-5 h-5 rounded flex items-center justify-center text-xs flex-shrink-0" style={{ background: (p.color || '#6366f1') + '20' }}>
                                            {p.icon || '📁'}
                                        </div>
                                        <span className={`text-[13px] truncate flex-1 ${active ? TEXT_ACTIVE : TEXT_IDLE}`}>{p.name}</span>
                                        {p.permission && p.permission !== 'owner' && (
                                            <span className="text-[9px] px-1 py-px rounded bg-blue-500/10 text-blue-500 font-medium flex-shrink-0">shared</span>
                                        )}
                                        {(!p.permission || p.permission === 'owner') && (
                                            <span
                                                onClick={(e) => { e.stopPropagation(); onEditProject?.(p); }}
                                                className="opacity-0 group-hover/p:opacity-100 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] text-sm px-1 rounded transition-all cursor-pointer"
                                                title="Edit project"
                                            >⋯</span>
                                        )}
                                    </button>
                                );
                            })}

                            {/* The project LIST had no entry point at all: it only
                                rendered once the detail view was closed, and
                                nothing opened it directly. Members, activity and
                                shared threads all live behind it. */}
                            <button
                                onClick={() => onBrowseProjects?.()}
                                className={`${ROW} ${ROW_IDLE} text-[var(--text-tertiary)]`}
                            >
                                <FolderOpen className="w-4 h-4" />
                                <span className="text-[13px]">{t('sidebar.all_projects')}</span>
                            </button>
                        </div>
                    )}
                    <div className="mx-3 my-0.5 border-t border-[var(--border-subtle)]" />
                </div>
);

export default ProjectsSection;
