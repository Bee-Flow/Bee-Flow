import React from 'react';
import { BookMarked, X } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';

/**
 * NotebookTOC — Table of Contents sidebar panel.
 *
 * `items` comes from the editor's TOC emitter; each item is
 * { id, level, textContent, isActive, isScrolledOver, itemIndex }.
 *
 * `onSelect(index)` scrolls the editor to that heading (the editor's
 * scrollToHeading): the headings carry no DOM ids, so looking one up by id —
 * the only thing a click did before — found nothing and nothing happened.
 */
// Indent per heading level as literal classes (Tailwind only emits what it can read whole).
const INDENT = ['pl-3', 'pl-6', 'pl-9', 'pl-12', 'pl-[60px]', 'pl-[72px]'];
const WEIGHT = { 1: 'font-semibold', 2: 'font-medium' };

export default function NotebookTOC({ items = [], onClose, onSelect }) {
    const { t } = useTranslation();
    if (!items || items.length === 0) {
        return (
            <div className="flex flex-col h-full items-center justify-center gap-2 px-4 text-[var(--text-tertiary)]">
                <BookMarked className="w-8 h-8 opacity-30" aria-hidden="true" />
                <p className="m-0 text-[11px] text-center">{t('notebooks.toc_empty', 'Add headings to your document to generate a Table of Contents.')}</p>
            </div>
        );
    }

    const scrollTo = (item, index) => {
        if (onSelect) { onSelect(item.itemIndex ?? index); return; }
        const el = item.id ? document.getElementById(item.id) : null;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-1.5">
                    <BookMarked className="w-3.5 h-3.5 text-[var(--accent-primary)]" aria-hidden="true" />
                    <h2 className="m-0 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
                        {t('notebooks.contents', 'Contents')}
                    </h2>
                </div>
                {onClose && (
                    <button
                        type="button"
                        onClick={onClose}
                        className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                        aria-label={t('notebooks.close_panel', 'Close')}
                        title={t('notebooks.close_panel', 'Close')}
                    >
                        <X className="w-3.5 h-3.5" aria-hidden="true" />
                    </button>
                )}
            </div>

            {/* TOC Items */}
            <div className="flex-1 overflow-y-auto custom-scrollbar py-2">
                {items.map((item, index) => (
                    <button
                        key={item.id ?? item.itemIndex ?? index}
                        type="button"
                        onClick={() => scrollTo(item, index)}
                        aria-current={item.isActive ? 'location' : undefined}
                        className={`w-full text-left pr-3 py-1 text-[11px] transition-colors hover:bg-[var(--bg-tertiary)] flex items-start gap-1 border-l-2 ${
                            INDENT[Math.min(Math.max((item.level || 1) - 1, 0), INDENT.length - 1)]
                        } ${WEIGHT[item.level] || 'font-normal'} ${
                            item.isActive ? 'text-[var(--accent-primary)] border-[var(--accent-primary)]' : 'text-[var(--text-secondary)] border-transparent'
                        }`}
                        title={item.textContent}
                    >
                        <span className="truncate leading-relaxed">{item.textContent}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
