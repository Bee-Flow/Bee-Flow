import { useMemo } from 'react';
import { useAppDocumentOptions } from '@/api/queries/studioAppDocuments';
import useTranslation from '@/hooks/useTranslation';
import { useFormField } from '../formContext';
import useInputChange from '../useInputChange';
import type { NodeProps } from './appNode.types';
import ComboBox, { type ComboOption } from './comboBox';
import { documentErrorText, useDocumentScope } from './documentCompare/DocShell';

/**
 * App Studio runtime — 'input_document'. Spec: server/appStudio/componentSpecs/documentSpecs.js.
 *
 * Pick one Studio document. The options are exactly what the builder listed
 * (`documentIds`) and what is in the owner's folder (`folderId`), narrowed by
 * `kind` — the server reads them as the app owner and answers only those
 * (routes/studioAppDocuments.js GET /:id/documents). SUBMITS the document id,
 * which a document_viewer or document_compare binds to (form.<name>), and
 * fires onChange the moment a document is picked.
 */

interface Props { name?: string; label?: string; kind?: string; documentIds?: string[]; folderId?: string | null; required?: boolean }

export default function AppInputDocument({ node }: NodeProps<Props>) {
    const { t } = useTranslation();
    const { name, label = t('studio_app_documents.picker_label', 'Document'), required = false } = node.props || {};
    const { value, setValue, error } = useFormField<string | null>({ name, defaultValue: null, required, label });
    const fireChange = useInputChange(node, name);
    const scope = useDocumentScope(node);
    const options = useAppDocumentOptions(scope);

    const choices = useMemo<ComboOption[]>(() => (options.data || []).map((d) => ({ id: d.id, label: d.name })), [options.data]);
    // A picked id that is not (or no longer) among the options still shows, by id, rather than vanishing.
    const known = value && !choices.some((c) => c.id === value) ? [...choices, { id: value, label: value }] : choices;

    return (
        <ComboBox
            id={`${node.id}-input`}
            label={label}
            required={required}
            error={error}
            options={known}
            selectedIds={value ? [value] : []}
            disabled={!scope.live}
            disabledText={t('studio_app_documents.picker_design', 'Documents can be picked when the app runs.')}
            placeholder={t('studio_app_documents.picker_search', 'Search documents…')}
            isLoading={options.isLoading}
            loadError={options.isError ? documentErrorText(t, options.error) : null}
            emptyText={t('studio_app_documents.picker_none', 'No documents to choose from.')}
            onPick={(id) => { setValue(String(id)); fireChange(String(id)); }}
            onRemove={() => { setValue(null); fireChange(null); }}
        />
    );
}
