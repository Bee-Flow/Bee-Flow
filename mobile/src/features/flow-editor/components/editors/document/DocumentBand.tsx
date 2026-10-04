/**
 * WHICH document a Fill in a document step fills — the web's "Document"
 * band (FillDocumentFields): search your documents, pick one (each says how
 * many placeholders it has), and, once picked, its instructions, the
 * revision the step is pinned to and whether each optional section is
 * printed by its rules, always or never. Picking another document starts its
 * section choices afresh.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { DocumentContract, DocumentTemplate } from '@/features/flow-editor/api';
import { SelectField, type SelectOption } from '@/features/flow-editor/components/fields';
import { SearchField } from '@/shared/ui';

import { pickDocument, placeholderCount, SECTION_CHOICES, sectionChoice } from './fillDocumentModel';
import { RevisionReview } from './RevisionReview';
import { say } from '../declarative/runtime';
import { Band } from '../shared/Band';
import { recordOf } from '../shared/list';
import { Note } from '../shared/Note';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';

export interface DocumentLookups {
    term: string;
    onTerm: (next: string) => void;
    /** Undefined until the first answer; kept while a new search is on its way. */
    templates: DocumentTemplate[] | undefined;
    templatesFailed: boolean;
    contract: DocumentContract | undefined;
    contractFailed: boolean;
    picked: DocumentTemplate | null;
    /** The rows the Values band will show — "none" gets a sentence here. */
    placeholderTotal: number;
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

function documentOptions(editor: StepEditorProps, look: DocumentLookups, describe: (d: DocumentTemplate) => string): SelectOption[] {
    const id = text(editor.draft.documentId);
    const options = (look.templates ?? []).map((d) => ({ value: d.id, label: d.name || d.id, description: describe(d) }));
    // The step's own document, even when a search (or a lost share) leaves it out of the list.
    if (id && !look.picked) options.unshift({ value: id, label: text(editor.draft.documentName) || look.contract?.name || id, description: '' });
    return options;
}

export function DocumentBand({ editor, look }: { editor: StepEditorProps; look: DocumentLookups }) {
    const t = useTranslation();
    const { draft, set, setMany, ctx } = editor;
    const id = text(draft.documentId);
    const overrides = recordOf(draft.sectionOverrides);
    const empty = look.templates?.length === 0 && !look.templatesFailed && look.term.trim() === '';
    return (
        <Band editor={editor} sectionKey="document" title={t('automations.versions.setting.documentId', 'Document')} defaultOpen hasContent={id !== ''}>
            <SearchField value={look.term} onChangeText={look.onTerm} placeholder={t('mobile.flow.fill.search', 'Search all templates…')} />
            <SelectField
                label={t('mobile.flow.fill.which', 'Which document')}
                hint={t('mobile.flow.fill.which_hint', 'One of the documents you designed in Studio → Documents. Design it there first if it is not in the list.')}
                required
                value={id}
                options={documentOptions(editor, look, (d) => say(t, placeholderCount(d)))}
                prompt={look.templates === undefined ? t('mobile.flow.fill.loading', 'Loading your documents…') : t('mobile.flow.fill.pick', 'Pick a document…')}
                onChange={(next) => setMany(pickDocument(next, look.templates?.find((d) => d.id === next) ?? null))}
                disabled={ctx.disabled}
                testID="fill-document"
            />
            {look.templatesFailed || look.contractFailed ? <Warn tone="error">{t('mobile.flow.fill.load_failed', 'Could not load your documents.')}</Warn> : null}
            {empty ? (
                <Note>
                    {t(
                        'mobile.flow.fill.none_yet',
                        'You have no documents yet. Design the invoice, quote or letter in Studio → Documents — write {example} where a value should land — and it appears here.',
                        { example: '{{customer.name}}' },
                    )}
                </Note>
            ) : null}
            {look.picked && look.placeholderTotal === 0 ? (
                <Note>
                    {t('mobile.flow.fill.no_placeholders_hint', 'This document has no placeholders, so it is sent exactly as designed. Add {marker} markers to it in Studio → Documents to fill it per run.', {
                        marker: '{{name}}',
                    })}
                </Note>
            ) : null}
            {look.contract?.instructions ? <Note>{look.contract.instructions}</Note> : null}
            {id ? <RevisionReview documentId={id} contract={look.contract} picked={look.picked} onPin={(v) => set('documentVersionId', v)} disabled={ctx.disabled} /> : null}
            {(look.contract?.sections ?? []).map((s) => (
                <SelectField
                    key={s.id}
                    label={s.title}
                    hint={s.summary || null}
                    value={sectionChoice(overrides, s.id)}
                    options={SECTION_CHOICES.map((c) => ({ value: c.value, label: say(t, c.label) }))}
                    onChange={(choice) => set('sectionOverrides', { ...overrides, [s.id]: choice })}
                    disabled={ctx.disabled}
                    testID={`fill-document-section-${s.id}`}
                />
            ))}
        </Band>
    );
}
