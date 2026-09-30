// The outline of a document: its headings (and sections without one), the
// section somebody else is editing marked, a click scrolls the document there.

import { ListTree, X } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import type { OutlineItem } from '../canvasBridge';
import { ICON_BUTTON } from './ui';

export interface OutlinePanelProps {
    items: OutlineItem[];
    activeSection: string | null;
    busySections: Record<string, string>;
    onGo: (item: OutlineItem) => void;
    onClose: () => void;
}

const INDENT = ['pl-2', 'pl-2', 'pl-5', 'pl-8'];

export default function OutlinePanel({ items, activeSection, busySections, onGo, onClose }: OutlinePanelProps) {
    const { t } = useTranslation();
    return (
        <aside className="w-64 shrink-0 overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)]" aria-label={t('documents.outline.title', 'Outline')} data-testid="document-outline">
            <div className="flex items-center gap-2 px-3 py-2.5">
                <ListTree size={14} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                <h2 className="flex-1 m-0 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('documents.outline.title', 'Outline')}</h2>
                <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={t('documents.outline.close', 'Close the outline')}><X size={14} /></button>
            </div>
            {!items.length && <p className="px-3 pb-3 text-xs text-[var(--text-tertiary)]">{t('documents.outline.empty', 'Headings and sections appear here as you write them.')}</p>}
            <ol className="pb-3">
                {items.map((item) => {
                    const busy = item.sectionId ? busySections[item.sectionId] : undefined;
                    const active = !!item.sectionId && item.sectionId === activeSection;
                    return (
                        <li key={`${item.index}-${item.text}`}>
                            <button type="button" onClick={() => onGo(item)}
                                className={`w-full text-left pr-3 py-1 text-[12px] truncate hover:bg-[var(--item-hover-bg)] ${INDENT[item.level] || 'pl-2'} ${active ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}`}>
                                {item.text || t('documents.outline.untitled', 'Untitled section')}
                                {busy && <span className="block text-[10px] text-[var(--warning-ink)]">{busy}</span>}
                            </button>
                        </li>
                    );
                })}
            </ol>
        </aside>
    );
}
