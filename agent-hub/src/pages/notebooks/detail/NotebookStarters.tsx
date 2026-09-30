/**
 * NotebookStarters — what an EMPTY notebook offers instead of a bare
 * placeholder: draft a first document from the sources, import a file, or
 * start from a simple outline.
 *
 * Drafting goes through the notebook's own chat (the same AI, the same
 * Privacy Shield, and the draft is written into the document like any other
 * AI edit), so there is one AI path, not two. Only editors see this.
 */
import React from 'react';
import { FileText, FileUp, ListChecks, NotebookPen, Sparkles, Table2 } from 'lucide-react';
import useTranslation from '../../../hooks/useTranslation';

interface Props {
    readySourceCount: number;
    onDraft: (prompt: string) => void;
    onImport: () => void;
    onTemplate: (markdown: string) => void;
}

export default function NotebookStarters({ readySourceCount, onDraft, onImport, onTemplate }: Props) {
    const { t } = useTranslation();
    const hasSources = readySourceCount > 0;
    const drafts = [
        {
            id: 'summary', icon: FileText, label: t('notebooks.starter_summary', 'Summary of the sources'),
            prompt: t('notebooks.starter_summary_prompt', 'Write an executive summary of my sources into the document, with the key findings and conclusions.'),
        },
        {
            id: 'briefing', icon: NotebookPen, label: t('notebooks.starter_briefing', 'Briefing document'),
            prompt: t('notebooks.starter_briefing_prompt', 'Write a briefing from my sources into the document: a summary, the analysis and recommendations.'),
        },
        {
            id: 'faq', icon: ListChecks, label: t('notebooks.starter_faq', 'Questions and answers'),
            prompt: t('notebooks.starter_faq_prompt', 'Write short questions and answers from my sources into the document, grouped by topic.'),
        },
        {
            id: 'table', icon: Table2, label: t('notebooks.starter_table', 'Key facts as a table'),
            prompt: t('notebooks.starter_table_prompt', 'Put the most important facts and figures from my sources into a table in the document.'),
        },
    ];
    const outline = `# ${t('notebooks.starter_outline_title', 'Title')}\n\n## ${t('notebooks.starter_outline_goal', 'Goal')}\n\n\n## ${t('notebooks.starter_outline_notes', 'Notes')}\n\n\n## ${t('notebooks.starter_outline_next', 'Next steps')}\n\n- [ ] \n`;

    return (
        <section
            aria-label={t('notebooks.starters_label', 'Start this notebook')}
            className="mx-auto w-full max-w-[640px] px-6 pt-6 pb-2"
            data-testid="notebook-starters"
        >
            <p className="m-0 mb-3 text-[13px] font-semibold text-[var(--text-primary)]">
                {t('notebooks.starters_title', 'Start with a draft, a file or an outline')}
            </p>
            <div className="grid grid-cols-2 gap-2">
                {drafts.map(({ id, icon: Icon, label, prompt }) => (
                    <button
                        key={id}
                        type="button"
                        disabled={!hasSources}
                        onClick={() => onDraft(prompt)}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-left text-[12.5px] text-[var(--text-primary)] hover:border-[var(--border-default)] disabled:opacity-50 disabled:cursor-not-allowed"
                        data-testid={`starter-${id}`}
                    >
                        <Sparkles className="w-3.5 h-3.5 shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                        <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                        <span className="truncate">{label}</span>
                    </button>
                ))}
                <button
                    type="button"
                    onClick={onImport}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-left text-[12.5px] text-[var(--text-primary)] hover:border-[var(--border-default)]"
                    data-testid="starter-import"
                >
                    <FileUp className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {t('notebooks.starter_import', 'Import a file (PDF, Word, text)')}
                </button>
                <button
                    type="button"
                    onClick={() => onTemplate(outline)}
                    className="flex items-center gap-2 px-3 py-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-left text-[12.5px] text-[var(--text-primary)] hover:border-[var(--border-default)]"
                    data-testid="starter-outline"
                >
                    <ListChecks className="w-3.5 h-3.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                    {t('notebooks.starter_outline', 'Simple outline')}
                </button>
            </div>
            {!hasSources && (
                <p className="m-0 mt-2 text-[12px] text-[var(--text-tertiary)]">
                    {t('notebooks.starters_need_sources', 'Add a source on the left to let the AI draft from it.')}
                </p>
            )}
        </section>
    );
}
