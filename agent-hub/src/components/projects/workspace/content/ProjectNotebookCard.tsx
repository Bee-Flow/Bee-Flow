// One notebook in the project's grid, in the look of the notebook library's
// card (tile, name, preview, counts) but with the project's own action: take
// it out of the project. Pinning, renaming and deleting stay in the notebook
// library, where the owner manages their notebooks.
//
// It says who changed the document last ("Edited by Anna · 5m ago") and
// carries a quiet dot when somebody else changed it since the reader last
// looked (the project's unread marks). A dot, never a count.
//
// For a reader who may not use notebooks (plan, role, operator switch) the
// card is not a button: the notebook editor would refuse to open it, and the
// tab says why once, above the grid.

import { BookOpen, Clock, FileText, User } from 'lucide-react';
import React from 'react';
import type { ProjectNotebook } from '../../../../api/queries/projectContent';
import useRelativeTime from '../../../../hooks/useRelativeTime';
import useTranslation from '../../../../hooks/useTranslation';
import ItemViewers from '../ItemViewers';
import { RemoveButton } from '../workspaceUi';

export interface ProjectNotebookCardProps {
    notebook: ProjectNotebook;
    ownerName: string;
    /** The name of whoever changed the document last ('' when unknown). */
    editorName?: string;
    /** Somebody else changed it since the reader last saw it. */
    unread?: boolean;
    canRemove: boolean;
    removing: boolean;
    onOpen: () => void;
    onRemove: () => void;
    /** False: shown, but not a way into the notebook (the reader may not use notebooks). */
    openable?: boolean;
}

function CardMeta({ notebook, ownerName, editorName }: { notebook: ProjectNotebook; ownerName: string; editorName: string }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const edited = !!(editorName && notebook.lastEditedAt);
    return (
        <>
        {edited && (
            <span className="block mb-1 text-[10.5px] truncate text-[var(--text-tertiary)]" data-testid="notebook-card-edited">
                {t('notebooks.card_edited_by', 'Edited by {name} · {when}', { name: editorName, when: rel(notebook.lastEditedAt) })}
            </span>
        )}
        <div className="flex items-center gap-2.5 text-[10.5px] text-[var(--text-tertiary)]">
            <span className="inline-flex items-center gap-1" title={t('project_content.notebook_sources', 'Sources')}>
                <FileText className="w-3 h-3" aria-hidden="true" />
                {t('project_content.notebook_source_count', '{count} sources', { count: notebook.sourceCount || 0 })}
            </span>
            {ownerName && (
                <span className="inline-flex items-center gap-1 min-w-0" title={t('project_content.col_owner', 'Owner')}>
                    <User className="w-3 h-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{ownerName}</span>
                </span>
            )}
            <span className="ml-auto shrink-0"><ItemViewers type="notebook" id={notebook.id} /></span>
            <span className="inline-flex items-center gap-1 shrink-0" title={t('project_content.col_updated', 'Updated')}>
                <Clock className="w-3 h-3" aria-hidden="true" />
                {rel(notebook.lastActivityAt || notebook.updatedAt)}
            </span>
        </div>
        </>
    );
}

function CardBody({ notebook, ownerName, editorName, unread }: { notebook: ProjectNotebook; ownerName: string; editorName: string; unread: boolean }) {
    const { t } = useTranslation();
    const preview = notebook.preview || notebook.description || '';
    return (
        <>
            <span className="flex items-start gap-2.5 mb-2">
                <span className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0 border-[1.5px] border-[var(--border-default)] bg-[var(--bg-tertiary)]">
                    <BookOpen className="w-4 h-4 text-[var(--brand-primary)]" aria-hidden="true" />
                    {unread && (
                        <span
                            className="absolute -top-1 -right-1 h-2.5 w-2.5 rounded-full bg-[var(--accent-primary)] ring-2 ring-[var(--bg-card)]"
                            aria-hidden="true"
                            data-testid="notebook-card-unread"
                        />
                    )}
                </span>
                <span className="flex-1 min-w-0 pt-0.5 pr-6 text-sm font-semibold truncate text-[var(--text-primary)]" title={notebook.name}>
                    {notebook.name}
                </span>
            </span>
            {preview ? (
                <span className="block text-xs leading-relaxed line-clamp-3 mb-2 text-[var(--text-secondary)]">{preview}</span>
            ) : (
                <span className="block text-xs italic mb-2 text-[var(--text-tertiary)]">
                    {t('project_content.notebook_empty', 'This notebook is empty. Open it to add sources and start writing.')}
                </span>
            )}
            <CardMeta notebook={notebook} ownerName={ownerName} editorName={editorName} />
        </>
    );
}

export default function ProjectNotebookCard({ notebook, ownerName, editorName = '', unread = false, canRemove, removing, onOpen, onRemove, openable = true }: ProjectNotebookCardProps) {
    const { t } = useTranslation();
    const body = <CardBody notebook={notebook} ownerName={ownerName} editorName={editorName} unread={unread} />;
    return (
        <div className="group relative rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] transition-all hover:shadow-md hover:border-[var(--border-default)]" data-testid={`project-notebook-${notebook.id}`}>
            {openable ? (
                <button
                    type="button"
                    onClick={onOpen}
                    aria-label={unread
                        ? t('notebooks.card_open_changed', 'Open notebook {name} (changed since you last looked)', { name: notebook.name })
                        : t('project_content.notebook_open_named', 'Open notebook {name}', { name: notebook.name })}
                    className="block w-full p-3.5 text-left rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]"
                >
                    {body}
                </button>
            ) : (
                <div className="block w-full p-3.5 text-left rounded-xl" data-testid={`project-notebook-${notebook.id}-closed`}>{body}</div>
            )}
            {canRemove && (
                <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    <RemoveButton
                        label={t('project_content.remove_named', 'Remove {name} from the project', { name: notebook.name })}
                        disabled={removing}
                        onClick={onRemove}
                    />
                </div>
            )}
        </div>
    );
}
