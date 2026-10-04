import { Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';

/** A flowlet the canvas is scoped to: the title row becomes a breadcrumb. */
export interface HeaderScope { key: string; title?: string; refCount?: number; empty?: boolean }

interface TitleFieldProps {
    title: string;
    scope?: HeaderScope | null;
    onRename?: ((next: string) => void) | null;
    onExitScope?: (() => void) | null;
    onDeleteLayer?: (() => void) | null;
}

/**
 * The automation name, renamed inline (click, type, Enter). While a flowlet is
 * open it reads `Automation / Flowlet`: the first half leaves the flowlet, the
 * second is the flowlet's own name, and a FLOWLET chip plus a delete action
 * follow. The rename commits through the scope-aware onRename of the shell.
 * A long name truncates (at most 40rem even on an ultrawide bar, so the
 * status stays beside it) and the tooltip carries the whole name.
 */
export default function TitleField({ title, scope = null, onRename, onExitScope, onDeleteLayer }: TitleFieldProps) {
    const { t } = useTranslation();
    const displayTitle = scope ? (scope.title || '') : (title || '');
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(displayTitle);
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => { if (!editing) setDraft(displayTitle); }, [displayTitle, editing]);
    useEffect(() => { if (editing) inputRef.current?.focus(); }, [editing]);
    // Don't carry an in-flight edit across a scope switch.
    useEffect(() => { setEditing(false); }, [scope?.key]);

    const commit = () => {
        const next = (draft || '').trim();
        setEditing(false);
        if (!next || next === displayTitle) { setDraft(displayTitle); return; }
        onRename?.(next);
    };

    const untitled = scope
        ? t('automations.header.untitled_flowlet', 'Untitled flowlet')
        : t('automations.header.untitled', 'Untitled automation');
    // An empty flowlet stays deletable however many call steps point at it:
    // there is nothing in it to lose (BFSF-340).
    const refs = scope?.refCount || 0;
    const layerInUse = refs > 0 && !scope?.empty;
    let deleteTitle = t('automations.header.delete_flowlet', 'Delete this flowlet');
    if (layerInUse) deleteTitle = t('automations.header.delete_flowlet_in_use', 'Used by {n} steps. Remove those first.', { n: refs });
    else if (refs > 0) deleteTitle = t('automations.header.delete_flowlet_empty', 'Delete this empty flowlet and the {n} "Call flowlet" steps that use it', { n: refs });

    return (
        <div className="min-w-0 flex items-center gap-2">
            {scope && (
                <>
                    <button
                        type="button"
                        onClick={() => onExitScope?.()}
                        title={`${title || t('automations.header.untitled', 'Untitled automation')}\n${t('automations.header.exit_scope', 'Back to the automation canvas')}`}
                        className="text-[14px] font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] truncate hover:bg-[var(--bg-secondary)] rounded px-1 -mx-1 transition text-left flex-shrink min-w-0 max-w-[10rem]"
                    >
                        {title || t('automations.header.untitled', 'Untitled automation')}
                    </button>
                    <span className="text-[14px] text-[var(--text-tertiary)] flex-shrink-0">/</span>
                </>
            )}
            {editing ? (
                <input
                    ref={inputRef}
                    value={draft}
                    aria-label={t('automations.header.rename_label', 'Name')}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { e.preventDefault(); commit(); }
                        else if (e.key === 'Escape') { setDraft(displayTitle); setEditing(false); }
                    }}
                    className="flex-1 min-w-0 text-[14px] font-semibold bg-transparent border-b border-[var(--accent-primary)] outline-none text-[var(--text-primary)]"
                />
            ) : (
                <button
                    type="button"
                    onClick={() => setEditing(true)}
                    title={`${displayTitle || untitled}\n${t('automations.header.rename_title', 'Click to rename')}`}
                    className="text-[14px] font-semibold text-[var(--text-primary)] truncate hover:bg-[var(--bg-secondary)] rounded px-1 -mx-1 transition text-left min-w-0 max-w-[40rem]"
                >
                    {displayTitle || untitled}
                </button>
            )}
            {scope && (
                <span className="text-[11px] uppercase tracking-wide font-medium px-2 py-0.5 rounded-full bg-[var(--bg-secondary)] text-[var(--text-secondary)] flex-shrink-0">
                    {t('automations.header.flowlet_chip', 'Flowlet')}
                </span>
            )}
            {scope && onDeleteLayer && (
                <button
                    type="button"
                    onClick={layerInUse ? undefined : () => onDeleteLayer()}
                    disabled={layerInUse}
                    title={deleteTitle}
                    aria-label={t('automations.header.delete_flowlet_label', 'Delete flowlet')}
                    className="p-1.5 rounded-lg text-[var(--text-tertiary)] hover:text-[var(--error)] hover:bg-[var(--bg-secondary)] transition disabled:opacity-40 disabled:hover:text-[var(--text-tertiary)] disabled:hover:bg-transparent flex-shrink-0"
                >
                    <Trash2 size={14} />
                </button>
            )}
        </div>
    );
}
