/**
 * Fill in a document — the web's FillDocumentFields
 * (actionEditors/documentFields.jsx): WHICH document (searched, picked, its
 * pinned revision and optional sections), a value per placeholder it
 * actually has, then the file and the options as the spec declares them.
 *
 * The document list and its contract come from the Documents API
 * (api/documents.ts). When neither can be read, the values the step already
 * binds stay editable under their stored names — the spec's own values band
 * — rather than vanish behind an error.
 */

import React, { useState } from 'react';

import { useDocumentContract, useDocumentTemplates } from '@/features/flow-editor/hooks';

import { DocumentBand, type DocumentLookups } from './DocumentBand';
import { isPresentation, placeholdersOf, plainSections } from './fillDocumentModel';
import { PlaceholderValues } from './PlaceholderValues';
import { specFor } from '../declarative/specs';
import { SpecSections } from '../declarative/SpecSections';
import type { StepEditorProps } from '../types';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

export function FillDocumentEditor(editor: StepEditorProps) {
    const { draft } = editor;
    const [term, setTerm] = useState('');
    const templates = useDocumentTemplates(term);
    const documentId = text(draft.documentId);
    const contract = useDocumentContract(documentId, text(draft.documentVersionId) || 'baseline');
    const picked = templates.data?.find((d) => d.id === documentId) ?? null;
    const placeholders = placeholdersOf(contract.data, picked);
    const look: DocumentLookups = {
        term,
        onTerm: setTerm,
        templates: templates.data,
        templatesFailed: templates.isError,
        contract: contract.data,
        contractFailed: contract.isError,
        picked,
        placeholderTotal: placeholders.length,
    };
    const sections = specFor('fill_document')?.sections ?? [];
    // Nothing to read the placeholders from: the stored values, as stored.
    const blind = documentId !== '' && contract.isError && !picked;
    return (
        <>
            <DocumentBand editor={editor} look={look} />
            {blind ? (
                <SpecSections {...editor} sections={sections.filter((s) => s.key === 'values')} />
            ) : (
                <PlaceholderValues editor={editor} placeholders={placeholders} />
            )}
            <SpecSections {...editor} sections={plainSections(sections, isPresentation(picked, contract.data))} />
        </>
    );
}
