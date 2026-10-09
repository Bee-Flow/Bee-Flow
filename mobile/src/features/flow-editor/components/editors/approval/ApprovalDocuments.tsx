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
            label={t('automations.approval_editors.documents_to_show', 'Documents to show')}
            hint={t('automations.approval_editors.files_earlier_steps_produced_a_generated', 'Files earlier steps produced (a generated PDF or Word document) that the approver can download before deciding. Up to 5.')}
        >
            {rows.map((att, i) => (
                <RowCard key={i} onRemove={() => onChange(removeAt(rows, i))} removeLabel={t('automations.approval_editors.remove_document', 'Remove document')} disabled={disabled}>
                    <BindingInput mode="template" value={att.binding || ''} onChange={(v) => onChange(patchAt(rows, i, { binding: String(v) }))} prompt={readableExample(FILE_EXAMPLE)} disabled={disabled} />
                    <TextField
                        value={att.label || ''}
                        onChangeText={(label) => onChange(patchAt(rows, i, { label }))}
                        placeholder={t('automations.approval_editors.shown_name_optional', 'Shown name (optional)')}
                        editable={!disabled}
                    />
                </RowCard>
            ))}
            {rows.length < MAX_ATTACHMENTS ? <AddButton label={t('automations.approval_editors.add_a_document', 'Add a document')} onPress={() => onChange([...rows, { binding: '', label: '' }])} disabled={disabled} /> : null}
        </FieldRow>
    );
}
