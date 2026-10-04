/**
 * NotebookHeaderStatus — what sits beside the notebook's name in the Studio
 * header: "View only" for a viewer, "In project X" with a link for a notebook
 * filed in one, who else is here (the live session's presence), the save
 * status, and one line of facts (sources, words, created) that gives way
 * first when the header gets narrow.
 */
import React from 'react';
import { Eye, FolderKanban } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import { projectRoutePath } from '../../../utils/projectRoutes';
import type { NotebookProjectSummary } from '../notebookQueries';

interface Props {
    readOnly: boolean;
    project: NotebookProjectSummary | null;
    meta?: string;
    presence?: React.ReactNode;
    saveStatus?: React.ReactNode;
    onOpenProject?: (projectId: string) => void;
}

export default function NotebookHeaderStatus({ readOnly, project, meta, presence, saveStatus, onOpenProject }: Props) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 min-w-0" data-testid="notebook-header-status">
            {readOnly && (
                <span
                    className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                    title={t('notebooks.view_only_hint', 'You can read this notebook and chat with it, but not change it.')}
                    data-testid="notebook-view-only"
                >
                    <Eye className="w-3 h-3" aria-hidden="true" />
                    {t('notebooks.view_only', 'View only')}
                </span>
            )}
            {project && (
                <a
                    href={projectRoutePath(project.id, 'notebooks')}
                    onClick={(e) => {
                        if (!onOpenProject || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                        e.preventDefault();
                        onOpenProject(project.id);
                    }}
                    className="shrink-0 max-w-[200px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-default)]"
                    data-testid="notebook-project-chip"
                >
                    <FolderKanban className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{t('notebooks.in_project', 'In {name}', { name: project.name })}</span>
                </a>
            )}
            {presence}
            {saveStatus}
            {meta && (
                <span className="min-w-0 truncate text-[11px] text-[var(--text-tertiary)] @max-[1440px]/objhead:hidden" data-testid="notebook-meta">{meta}</span>
            )}
        </div>
    );
}
