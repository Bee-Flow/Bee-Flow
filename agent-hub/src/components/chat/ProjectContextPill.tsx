import { X } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { projectIcon, projectTileStyle } from '../projects/workspace/projectVisuals';

/**
 * The project a chat is happening in, shown next to the chat header.
 *
 * While a project is the chat context, every turn carries its id: the server
 * then applies the project's instructions and knowledge and files a new
 * conversation in it. That used to be invisible — the only cue was a
 * highlighted sidebar row — so a person could not tell whether their next
 * message would be grounded on the project or not. The pill says so, opens the
 * project, and its ✕ leaves the project context for the chats that follow.
 */

export interface ProjectContextPillProject {
    id: string;
    name?: string;
    icon?: string;
    color?: string;
}

export interface ProjectContextPillProps {
    project: ProjectContextPillProject;
    onOpen: () => void;
    onLeave: () => void;
    /** Narrow screens: the icon only, the name stays in the labels. */
    compact?: boolean;
}

export default function ProjectContextPill({ project, onOpen, onLeave, compact = false }: ProjectContextPillProps) {
    const { t } = useTranslation();
    const name = project.name || t('sidebar.projects', 'Projects');
    return (
        <span
            className="inline-flex items-center h-7 max-w-[260px] rounded-full border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            data-testid="project-context-pill"
            title={t('sidebar.project_context_label', 'Chatting in project {name}', { name })}
        >
            <button
                type="button"
                onClick={onOpen}
                aria-label={t('sidebar.project_context_open', 'Open project {name}', { name })}
                className="inline-flex items-center gap-1.5 min-w-0 h-full pl-1 pr-1.5 rounded-l-full hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
                <span aria-hidden="true" style={projectTileStyle(project.color, 20)}>
                    {projectIcon(project.icon)}
                </span>
                {!compact && <span className="text-xs font-medium truncate">{name}</span>}
            </button>
            <button
                type="button"
                onClick={onLeave}
                aria-label={t('sidebar.project_context_leave', 'Stop chatting in project {name}', { name })}
                title={t('sidebar.project_context_leave', 'Stop chatting in project {name}', { name })}
                className="inline-flex items-center justify-center w-6 h-full rounded-r-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            >
                <X className="w-3 h-3" aria-hidden="true" />
            </button>
        </span>
    );
}
