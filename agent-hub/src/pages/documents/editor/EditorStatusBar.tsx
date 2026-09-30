// The quiet line under a document: words, pages (or slides), and where the
// caret is.

import React from 'react';
import useTranslation from '../../../hooks/useTranslation';

export interface EditorStatusBarProps {
    words: number | null;
    pages?: number | null;
    slides?: number | null;
    where?: string | null;
    extra?: React.ReactNode;
}

export default function EditorStatusBar({ words, pages, slides, where, extra }: EditorStatusBarProps) {
    const { t } = useTranslation();
    const parts: string[] = [];
    if (slides) parts.push(t('documents.status.slides', '{count} slides', { count: slides }));
    if (words != null) parts.push(t('documents.status.words', '{count} words', { count: words }));
    if (pages) parts.push(pages === 1 ? t('documents.status.one_page', 'about 1 page') : t('documents.status.pages', 'about {count} pages', { count: pages }));
    return (
        <footer className="flex items-center gap-3 px-4 py-1 text-[11px] shrink-0 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)]" data-testid="document-status-bar">
            <span className="tabular-nums">{parts.join(' · ')}</span>
            {where && <span className="truncate">{t('documents.status.in_section', 'In: {section}', { section: where })}</span>}
            <span className="ml-auto flex items-center gap-2">{extra}</span>
        </footer>
    );
}
