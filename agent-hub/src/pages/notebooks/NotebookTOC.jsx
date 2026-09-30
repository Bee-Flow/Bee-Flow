import React from 'react';
import { BookMarked } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';

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
export default function NotebookTOC({ items = [], onClose, onSelect }) {
    const { t } = useTranslation();
    if (!items || items.length === 0) {
        return (
            <div className="flex flex-col h-full items-center justify-center gap-2 px-4" style={{ color: 'var(--text-tertiary)' }}>
                <BookMarked className="w-8 h-8 opacity-30" />
                <p className="text-[11px] text-center">{t('notebooks.toc_empty', 'Add headings to your document to generate a Table of Contents.')}</p>
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
            <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex items-center gap-1.5">
                    <BookMarked className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} />
                    <span className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                        {t('notebooks.contents', 'Contents')}
                    </span>
                </div>
                {onClose && (
                    <button
                        onClick={onClose}
                        className="p-1 rounded hover:bg-[var(--bg-tertiary)] transition-colors text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]"
                        aria-label={t('notebooks.close', 'Close')}
                        title={t('notebooks.close', 'Close')}
                    >
                        ×
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
                        className="w-full text-left px-3 py-1 text-[11px] transition-colors hover:bg-[var(--bg-tertiary)] flex items-start gap-1 group"
                        style={{
                            paddingLeft: `${(item.level - 1) * 12 + 12}px`,
                            color: item.isActive ? 'var(--accent-primary)' : 'var(--text-secondary)',
                            fontWeight: item.level === 1 ? '600' : item.level === 2 ? '500' : '400',
                            borderLeft: item.isActive ? '2px solid var(--accent-primary)' : '2px solid transparent',
                        }}
                        title={item.textContent}
                    >
                        <span className="truncate leading-relaxed">{item.textContent}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}
