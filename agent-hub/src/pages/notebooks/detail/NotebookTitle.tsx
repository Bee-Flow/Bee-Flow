/**
 * NotebookTitle — the notebook header's title block.
 *
 *   - the title, renamed in place by anyone who may edit (click or Enter on
 *     it; Enter saves, Escape puts the old title back, a failure says so and
 *     keeps what was typed);
 *   - "View only" for a viewer, so a read-only editor never looks broken;
 *   - "In project X" with a link to the project, for a notebook filed in one;
 *   - who else is here (the live session's presence), when co-edited;
 *   - one line of facts under it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, FolderKanban } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';
import { projectRoutePath } from '../../../utils/projectRoutes';
import type { NotebookProjectSummary } from '../notebookQueries';

interface Props {
    name: string;
    canRename: boolean;
    readOnly: boolean;
    project: NotebookProjectSummary | null;
    meta?: string;
    presence?: React.ReactNode;
    /** Changes to start renaming (the command palette's "Rename notebook"). */
    editSignal?: number;
    onRename: (name: string) => Promise<unknown>;
    onOpenProject?: (projectId: string) => void;
}

const MAX_NAME = 500;

export default function NotebookTitle({ name, canRename, readOnly, project, meta, presence, editSignal = 0, onRename, onOpenProject }: Props) {
    const { t } = useTranslation();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { if (!editing) setDraft(name); }, [name, editing]);
    useEffect(() => { if (editing) inputRef.current?.select(); }, [editing]);
    useEffect(() => { if (editSignal > 0 && canRename) setEditing(true); }, [editSignal, canRename]);

    const commit = async () => {
        const next = draft.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
        if (!next || next === name) { setEditing(false); setDraft(name); setError(null); return; }
        setSaving(true);
        setError(null);
        try {
            await onRename(next);
            setEditing(false);
        } catch (e) {
            setError(t('notebooks.rename_failed', 'The name could not be saved: {message}', { message: (e as Error).message }));
            inputRef.current?.focus();
        } finally {
            setSaving(false);
        }
    };

    return (
        <div className="min-w-0">
            <div className="flex items-center gap-2 min-w-0">
                {editing ? (
                    <input
                        ref={inputRef}
                        value={draft}
                        maxLength={MAX_NAME}
                        disabled={saving}
                        aria-label={t('notebooks.rename_notebook', 'Notebook name')}
                        aria-invalid={error ? true : undefined}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => { void commit(); }}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); void commit(); }
                            if (e.key === 'Escape') { e.preventDefault(); setDraft(name); setEditing(false); setError(null); }
                        }}
                        className="min-w-0 flex-1 text-base font-bold px-1.5 py-0.5 rounded-md border border-[var(--accent-primary)] bg-[var(--bg-primary)] text-[var(--text-primary)] outline-none"
                        data-testid="notebook-title-input"
                    />
                ) : canRename ? (
                    <button
                        type="button"
                        onClick={() => setEditing(true)}
                        className="min-w-0 truncate text-left text-base font-bold rounded-md px-1 -mx-1 text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                        title={t('notebooks.rename_hint', 'Rename')}
                        data-testid="notebook-title"
                    >
                        {name}
                    </button>
                ) : (
                    <h2 className="m-0 min-w-0 truncate text-base font-bold text-[var(--text-primary)]" title={name} data-testid="notebook-title">{name}</h2>
                )}
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
                        className="shrink-0 max-w-[220px] inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--border-default)]"
                        data-testid="notebook-project-chip"
                    >
                        <FolderKanban className="w-3 h-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('notebooks.in_project', 'In {name}', { name: project.name })}</span>
                    </a>
                )}
                {presence}
            </div>
            {error && <p role="alert" className="m-0 mt-0.5 text-[12px] text-[var(--error)]">{error}</p>}
            {!error && meta && <p className="m-0 mt-0.5 text-[12px] truncate text-[var(--text-tertiary)]">{meta}</p>}
        </div>
    );
}
