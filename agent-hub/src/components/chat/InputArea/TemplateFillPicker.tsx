/**
 * The template picker behind "Fill in a template" in the composer's "+" menu:
 * the caller's own templates and those shared with them (the Documents
 * library's own query), with a search box. Choosing one hands it to `onPick`;
 * useTemplateFill turns that into the chat message.
 *
 * Like every picker in the "+" menu's flyout it is a `<div class="relative">`
 * wrapping its absolutely positioned panel, and the menu closes it on an
 * outside click.
 */
import { useState } from 'react';
import { FileText, Presentation, Search } from 'lucide-react';

import { useMyTemplatesQuery, type MyTemplate } from '@/api/queries/projectContent';
import useTranslation from '@/hooks/useTranslation';

interface TemplateFillListProps {
    templates: MyTemplate[];
    loading: boolean;
    failed: boolean;
    onPick: (template: MyTemplate) => void;
}

/** The list itself, without the fetch: what it shows for each state, and the search. */
export function TemplateFillList({ templates, loading, failed, onPick }: TemplateFillListProps) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const needle = search.trim().toLowerCase();
    const shown = needle ? templates.filter((tpl) => tpl.name.toLowerCase().includes(needle)) : templates;
    let note: string | null = null;
    if (loading) note = t('chat_templates.loading', 'Loading templates…');
    else if (failed) note = t('chat_templates.load_error', 'Your templates could not be loaded.');
    else if (templates.length === 0) note = t('chat_templates.empty', 'No templates yet. Make one in Studio → Documents.');
    else if (shown.length === 0) note = t('chat_templates.no_match', 'No template matches your search.');

    return (
        <div
            role="dialog"
            aria-label={t('chat_templates.menu_label', 'Fill in a template')}
            data-testid="template-fill-picker"
            data-solid-popover
            className="absolute bottom-full left-0 mb-2 w-[300px] max-h-[380px] flex flex-col bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl shadow-xl p-1.5 z-50"
        >
            <label className="flex items-center gap-2 px-2 py-1.5 mb-1 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-subtle)]">
                <Search size={14} className="text-[var(--text-tertiary)] shrink-0" aria-hidden="true" />
                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('chat_templates.search_placeholder', 'Search templates…')}
                    aria-label={t('chat_templates.search_placeholder', 'Search templates…')}
                    className="flex-1 min-w-0 bg-transparent text-sm outline-none text-[var(--text-primary)]"
                />
            </label>
            {note && <p className="px-2 py-3 text-xs text-[var(--text-tertiary)]">{note}</p>}
            {!loading && !failed && shown.length > 0 && (
                <ul className="overflow-y-auto">
                    {shown.map((tpl) => {
                        const deck = tpl.docType === 'presentation';
                        const Icon = deck ? Presentation : FileText;
                        return (
                            <li key={tpl.id}>
                                <button
                                    type="button"
                                    onClick={() => onPick(tpl)}
                                    data-testid={`template-fill-option-${tpl.id}`}
                                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left text-sm text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                                >
                                    <Icon size={14} className="text-[var(--text-tertiary)] shrink-0" aria-hidden="true" />
                                    <span className="flex-1 min-w-0 truncate">{tpl.name}</span>
                                    <span className="text-[11px] text-[var(--text-tertiary)] shrink-0">
                                        {deck ? t('chat_templates.type_presentation', 'Presentation') : t('chat_templates.type_document', 'Document')}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}

interface TemplateFillPickerProps {
    enabled: boolean;
    open: boolean;
    onPick: (template: MyTemplate) => void;
}

/** The list with its fetch: mounted only while the picker is open, so a closed menu asks nothing. */
function TemplateFillQueryList({ onPick }: { onPick: (template: MyTemplate) => void }) {
    const query = useMyTemplatesQuery(true);
    return (
        <TemplateFillList
            templates={query.data?.templates ?? []}
            loading={query.isLoading}
            failed={query.isError}
            onPick={onPick}
        />
    );
}

export default function TemplateFillPicker({ enabled, open, onPick }: TemplateFillPickerProps) {
    if (!enabled) return null;
    return <div className="relative">{open && <TemplateFillQueryList onPick={onPick} />}</div>;
}
