// The row of a designed document's own tools: parameters, sections, design
// (or a deck's look), the customer preview and the assistant.

import React from 'react';
import useTranslation from '../../../hooks/useTranslation';

export type WorkspaceTab = 'parameters' | 'sections' | 'design' | 'preview' | 'assistant';

export interface WorkspaceTabsProps {
    isDeck: boolean;
    tab: WorkspaceTab | null;
    onTab: (tab: WorkspaceTab | null) => void;
    slideCount: number;
}

export default function WorkspaceTabs({ isDeck, tab, onTab, slideCount }: WorkspaceTabsProps) {
    const { t } = useTranslation();
    const tabs: Array<[WorkspaceTab, string]> = isDeck
        ? [['design', t('documents.tools.look', 'Look')], ['parameters', t('documents.tools.parameters', 'Parameters')], ['preview', t('documents.tools.preview', 'Customer preview')], ['assistant', t('documents.tools.assistant', 'AI assistant')]]
        : [['parameters', t('documents.tools.parameters', 'Parameters')], ['sections', t('documents.tools.sections', 'Sections')], ['design', t('documents.tools.design', 'Design')], ['preview', t('documents.tools.preview', 'Customer preview')], ['assistant', t('documents.tools.assistant', 'AI assistant')]];
    return (
        <nav className="flex flex-wrap items-center gap-1 px-4 py-1.5 border-b border-[var(--border-subtle)]" aria-label={t('documents.tools.label', 'Document tools')}>
            {tabs.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={tab === key} onClick={() => onTab(tab === key ? null : key)}
                    className={`text-xs rounded px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] ${tab === key ? 'bg-[var(--bg-tertiary)] font-semibold text-[var(--text-primary)]' : ''}`}>
                    {label}
                </button>
            ))}
            {isDeck && slideCount > 0 && (
                <span className="ml-auto text-xs text-[var(--text-tertiary)]" data-testid="document-slide-count">{t('documents.slides_count', '{count} slides', { count: slideCount })}</span>
            )}
        </nav>
    );
}
