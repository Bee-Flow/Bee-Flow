/**
 * The editor's sections, in the web's order. A page: its text, Parameters,
 * Sections, Design, Customer preview, and History. A presentation: its
 * outline, Parameters, Customer preview and History — its look is chosen on
 * the web, and reusable sections do not apply to a deck.
 */

import type { TranslateFn } from '@/core/i18n';

export type EditorTab = 'content' | 'parameters' | 'sections' | 'design' | 'preview' | 'history';

export function editorTabs(t: TranslateFn, deck: boolean): { id: EditorTab; label: string }[] {
    const content = deck ? t('mobile.studio_documents.tab.outline', 'Outline') : t('mobile.studio_documents.tab.text', 'Text');
    const all: { id: EditorTab; label: string; page?: true }[] = [
        { id: 'content', label: content },
        { id: 'parameters', label: t('mobile.studio_documents.tab.parameters', 'Parameters') },
        { id: 'sections', label: t('mobile.studio_documents.tab.sections', 'Sections'), page: true },
        { id: 'design', label: t('mobile.studio_documents.tab.design', 'Design'), page: true },
        { id: 'preview', label: t('mobile.studio_documents.tab.preview', 'Customer preview') },
        { id: 'history', label: t('documents.history', 'History') },
    ];
    return all.filter((tab) => !deck || !tab.page).map(({ id, label }) => ({ id, label }));
}

/** The header's status chip: the autosave while it matters, else the type. */
export function saveStatus(t: TranslateFn, state: 'idle' | 'saving' | 'saved' | 'error', typeLabel: string): string {
    if (state === 'saving') return t('documents.saving', 'Saving…');
    if (state === 'saved') return t('documents.saved', 'Saved');
    if (state === 'error') return t('documents.save_error', 'Not saved');
    return typeLabel;
}
