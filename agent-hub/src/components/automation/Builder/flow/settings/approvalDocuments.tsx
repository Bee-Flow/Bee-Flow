import { Plus, Trash2 } from 'lucide-react';
import type { ComponentProps } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import TemplateField from '../../mapping/TemplateField';
import { controlSurfaceClass, FormRow } from './formPrimitives';
import type { ApprovalAttachmentRow, SetDraft } from './approvalTypes';

type TemplateFieldProps = ComponentProps<typeof TemplateField>;

interface ApprovalDocumentsFieldProps {
    attachments: ApprovalAttachmentRow[];
    set: SetDraft;
    onFocusField: TemplateFieldProps['onFocusField'];
    previewSample: TemplateFieldProps['previewSample'];
}

/** "Documents to show": files earlier steps produced, which the approver can download before deciding. */
export function ApprovalDocumentsField({ attachments, set, onFocusField, previewSample }: ApprovalDocumentsFieldProps) {
    const { t } = useTranslation();
    const setAttachment = (i: number, patchRow: Partial<ApprovalAttachmentRow>) => {
        const next = attachments.map((row, idx) => (idx === i ? { ...row, ...patchRow } : row));
        set('attachments', next);
    };
    return (
        <FormRow
            label={t('automations.approval_editors.documents_to_show', 'Documents to show')}
            hint={t('automations.approval_editors.files_earlier_steps_produced_a_generated', 'Files earlier steps produced (a generated PDF or Word document) that the approver can download before deciding. Up to 5.')}
        >
            <div className="space-y-1.5">
                {attachments.map((att, i) => (
                    <div key={i} className="flex items-start gap-1.5">
                        <div className="flex-1 min-w-0">
                            <TemplateField
                                value={att.binding || ''}
                                onChange={(next: string) => setAttachment(i, { binding: next })}
                                rows={1}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                placeholder="{{steps.doc.output.fileId}}"
                            />
                        </div>
                        <input
                            type="text"
                            value={att.label || ''}
                            onChange={(e) => setAttachment(i, { label: e.target.value })}
                            placeholder={t('automations.approval_editors.shown_name_optional', 'Shown name (optional)')}
                            className={controlSurfaceClass('w-40 shrink-0 px-2 py-1.5 text-sm')}
                        />
                        <button
                            type="button"
                            aria-label={t('automations.approval_editors.remove_document', 'Remove document')}
                            onClick={() => set('attachments', attachments.filter((_, idx) => idx !== i))}
                            className="p-1.5 text-[var(--text-tertiary)] hover:text-red-500 transition"
                        >
                            <Trash2 size={14} />
                        </button>
                    </div>
                ))}
                {attachments.length < 5 && (
                    <button
                        type="button"
                        onClick={() => set('attachments', [...attachments, { binding: '', label: '' }])}
                        className="inline-flex items-center gap-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
                    >
                        <Plus size={12} /> {t('automations.approval_editors.add_a_document', 'Add a document')}
                    </button>
                )}
            </div>
        </FormRow>
    );
}
