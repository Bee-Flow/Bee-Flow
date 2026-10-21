import type { ComponentType } from 'react';
import { useTranslation } from '../../../../../../hooks/useTranslation';
import TemplateFieldJs from '../../../mapping/TemplateField';
import { textareaClass } from '../formPrimitives';
import type { FieldEditorProps } from './fieldEditor.types';
import { INFO_MAX_LEN } from './fieldKinds';

// A JavaScript component whose props TypeScript infers from their defaults.
const TemplateField = TemplateFieldJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * A text block: some words shown between the questions (instructions, a
 * reminder, what happens next). It asks nothing, so it has no "required" and
 * no binding name. The text is markdown; on a later page it can also hold
 * values from earlier steps, filled in when the page is shown.
 */
export default function InfoFieldEditor({ field, index, onChange, allowVariables = false, onFocusField = null, previewSample = null }: FieldEditorProps) {
    const { t } = useTranslation();
    const content = field.content || '';
    const ariaLabel = `Text block ${index + 1}`;
    return (
        <div className="space-y-0.5">
            <div className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]">{t('automations.form_wizard.info_content', 'Text')}</div>
            {allowVariables ? (
                <TemplateField
                    value={content}
                    onChange={(next: string) => onChange({ content: next })}
                    rows={4}
                    multiline
                    ariaLabel={ariaLabel}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder={t('automations.form_wizard.info_placeholder', 'Write what people should read here.')}
                    listAs="markdown"
                />
            ) : (
                <textarea
                    rows={4}
                    maxLength={INFO_MAX_LEN}
                    aria-label={ariaLabel}
                    value={content}
                    onChange={(e) => onChange({ content: e.target.value })}
                    className={textareaClass()}
                    placeholder={t('automations.form_wizard.info_placeholder', 'Write what people should read here.')}
                />
            )}
            <p className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.form_wizard.info_help', 'Shown as it is between the questions. You can use **bold**, lists and links. Nothing is asked or saved.')}
            </p>
            {content.length > INFO_MAX_LEN && (
                <p role="alert" className="text-[10px] text-amber-600 dark:text-amber-500">
                    {t('automations.form_wizard.info_too_long', 'This text is longer than {max} characters.', { max: INFO_MAX_LEN })}
                </p>
            )}
        </div>
    );
}
