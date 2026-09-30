/**
 * What the approver sees besides the question: the documents earlier steps
 * made, up to 5 — the web's "Documents to show" (approvalEditors.jsx).
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { BindingInput, FieldRow } from '@/features/flow-editor/components/fields';
import { readableExample } from '@/features/flow-editor/components/outline/readableText';
import { TextField } from '@/shared/ui';

import { MAX_ATTACHMENTS } from './approvalModel';
import { AddButton } from '../shared/AddButton';
import { patchAt, removeAt } from '../shared/list';
import { RowCard } from '../shared/RowCard';

/** The example binding in an empty document row: a path, not copy — shown as its pill reads. */
const FILE_EXAMPLE = '{{steps.doc.output.fileId}}';

type Attachment = { binding?: string; label?: string };

export function ApprovalDocuments({ rows, onChange, disabled }: { rows: Attachment[]; onChange: (next: Attachment[]) => void; disabled: boolean }) {
    const t = useTranslation();
    return (
        <FieldRow
            label={t('mobile.flow.approval.documents', 'Documents to show')}
            hint={t('mobile.flow.approval.documents_hint', 'Files earlier steps produced (a generated PDF or Word document) that the approver can download before deciding. Up to 5.')}
        >
            {rows.map((att, i) => (
                <RowCard key={i} onRemove={() => onChange(removeAt(rows, i))} removeLabel={t('mobile.flow.approval.remove_document', 'Remove document')} disabled={disabled}>
                    <BindingInput mode="template" value={att.binding || ''} onChange={(v) => onChange(patchAt(rows, i, { binding: String(v) }))} prompt={readableExample(FILE_EXAMPLE)} disabled={disabled} />
                    <TextField
                        value={att.label || ''}
                        onChangeText={(label) => onChange(patchAt(rows, i, { label }))}
                        placeholder={t('mobile.flow.approval.shown_name', 'Shown name (optional)')}
                        editable={!disabled}
                    />
                </RowCard>
            ))}
            {rows.length < MAX_ATTACHMENTS ? <AddButton label={t('mobile.flow.approval.add_document', 'Add a document')} onPress={() => onChange([...rows, { binding: '', label: '' }])} disabled={disabled} /> : null}
        </FieldRow>
    );
}
