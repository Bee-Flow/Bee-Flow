/**
 * LinkTools — the link UI: a bubble when the caret is in a link (open, edit,
 * remove) and a small inline editor for the address. It replaces the
 * browser's prompt dialog, which blocked the page, could not be styled or
 * translated and lost the selection on some platforms.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { Check, ExternalLink, Pencil, Trash2, X } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { normalizeHref } from '../engine/links';

export interface AnchorRect { top: number; left: number; bottom: number }

const EDITOR_WIDTH = 340;

function place(rect: AnchorRect, width: number) {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
    return { top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, vw - width - 8)) };
}

interface EditorProps {
    rect: AnchorRect;
    initialHref: string;
    canRemove: boolean;
    onApply: (href: string) => void;
    onRemove: () => void;
    onClose: () => void;
}

/** Inline address editor. Enter applies, Escape cancels; focus returns to the text. */
export function LinkEditor({ rect, initialHref, canRemove, onApply, onRemove, onClose }: EditorProps) {
    const { t } = useTranslation();
    const [value, setValue] = useState(initialHref);
    const [invalid, setInvalid] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const boxRef = useRef<HTMLDivElement>(null);
    const inputId = useId();
    const errorId = useId();

    useEffect(() => {
        const id = requestAnimationFrame(() => { inputRef.current?.focus(); inputRef.current?.select(); });
        return () => cancelAnimationFrame(id);
    }, []);

    useEffect(() => {
        const onDown = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) onClose(); };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
    }, [onClose]);

    const apply = () => {
        const href = normalizeHref(value);
        if (!href) { setInvalid(true); inputRef.current?.focus(); return; }
        onApply(href);
    };

    return (
        <div
            ref={boxRef}
            className="bf-floating-panel fixed z-[9999] flex flex-col gap-1.5 p-2 w-[340px] max-w-[94vw]"
            style={place(rect, EDITOR_WIDTH)}
            role="dialog"
            aria-label={t('editor.link_dialog', 'Link')}
        >
            <label htmlFor={inputId} className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                {t('editor.link_address', 'Link address')}
            </label>
            <div className="flex items-center gap-1.5">
                <input
                    id={inputId}
                    ref={inputRef}
                    value={value}
                    onChange={(e) => { setValue(e.target.value); setInvalid(false); }}
                    onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); apply(); } else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
                    }}
                    placeholder={t('editor.link_placeholder', 'example.com or https://…')}
                    aria-invalid={invalid || undefined}
                    aria-describedby={invalid ? errorId : undefined}
                    className="flex-1 min-w-0 px-2 py-1 rounded-md text-xs bg-[var(--bg-secondary)] text-[var(--text-primary)] border border-[var(--border-default)] outline-none focus:border-[var(--accent-primary)]"
                />
                <button type="button" onClick={apply} className="bf-icon-button bf-icon-button--primary" aria-label={t('editor.link_apply', 'Apply link')} title={t('editor.link_apply', 'Apply link')}>
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
                {canRemove && (
                    <button type="button" onClick={onRemove} className="bf-icon-button bf-icon-button--danger" aria-label={t('editor.link_remove', 'Remove link')} title={t('editor.link_remove', 'Remove link')}>
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                )}
                <button type="button" onClick={onClose} className="bf-icon-button" aria-label={t('editor.cancel', 'Cancel')} title={t('editor.cancel', 'Cancel')}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
            {invalid && (
                <p id={errorId} className="text-[11px] text-red-500">
                    {t('editor.link_invalid', 'Enter a web address, such as example.com.')}
                </p>
            )}
        </div>
    );
}

interface BubbleProps {
    rect: AnchorRect;
    href: string;
    editable: boolean;
    onEdit: () => void;
    onRemove: () => void;
}

/** Shown while the caret sits in a link. */
export function LinkBubble({ rect, href, editable, onEdit, onRemove }: BubbleProps) {
    const { t } = useTranslation();
    return (
        <div
            className="bf-floating-panel fixed z-[9998] flex items-center gap-1.5 px-2 py-1 max-w-[360px]"
            style={place(rect, 360)}
            onMouseDown={(e) => e.preventDefault()}
        >
            <ExternalLink className="w-3 h-3 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[11px] truncate max-w-[180px] text-[var(--accent-primary)]" title={href}>
                {href || '—'}
            </a>
            {editable && (
                <>
                    <button type="button" onClick={onEdit} className="bf-icon-button" aria-label={t('editor.link_edit', 'Edit link')} title={t('editor.link_edit', 'Edit link')}>
                        <Pencil className="w-3 h-3" aria-hidden="true" />
                    </button>
                    <button type="button" onClick={onRemove} className="bf-icon-button bf-icon-button--danger" aria-label={t('editor.link_remove', 'Remove link')} title={t('editor.link_remove', 'Remove link')}>
                        <Trash2 className="w-3 h-3" aria-hidden="true" />
                    </button>
                </>
            )}
        </div>
    );
}
