import { useTranslation } from '@/hooks/useTranslation';
import type { FieldEditorProps } from './fieldEditor.types';
import { PER_ITEM_NAME_MAX, canAskPerItem } from './fieldKinds';
import SourceSpecEditor from './SourceSpecEditor';

interface Props extends FieldEditorProps {
    /** `steps.<id>.output`: where this question's answers land for later steps. */
    bindingBase: string;
}

/**
 * "Ask this once per item of a list": the question is repeated for every item
 * of a list from an earlier step (one rating per product, one yes/no per
 * attendee). The answers come back as ONE list of
 * `{ key, label, answer }`, in the order of the items.
 */
export default function PerItemEditor({ field, index, onChange, bindingBase, allowVariables = false, onFocusField = null, previewSample = null }: Props) {
    const { t } = useTranslation();
    if (!allowVariables || !canAskPerItem(field)) return null;
    const on = !!field.fieldsFrom;
    const n = index + 1;
    const tooLong = (field.name || '').length > PER_ITEM_NAME_MAX;
    return (
        <div className="space-y-1.5">
            <label className="flex items-center gap-1.5 text-[11px] text-[var(--text-secondary)] cursor-pointer select-none">
                <input
                    type="checkbox"
                    aria-label={`Question ${n} once per item`}
                    checked={on}
                    onChange={(e) => onChange({ fieldsFrom: e.target.checked ? { ref: '' } : undefined })}
                />
                {t('automations.form_wizard.per_item_toggle', 'Ask this once per item of a list')}
            </label>
            {on && (
                <div className="space-y-1.5 pl-5">
                    <p className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.form_wizard.per_item_help', 'The question is repeated for each item of the list. Its label becomes the heading; the text under the heading is the question’s help.')}
                    </p>
                    <SourceSpecEditor
                        spec={field.fieldsFrom}
                        onChange={(fieldsFrom) => onChange({ fieldsFrom })}
                        kind="questions"
                        ariaBase={`Question ${n} items`}
                        previewSample={previewSample}
                        onFocusField={onFocusField}
                    />
                    <p className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.form_wizard.per_item_output', 'Later steps get the answers as a list:')}{' '}
                        <code>{`${bindingBase}.${field.name || 'name'}`}</code> = <code>{'[{ key, label, answer }]'}</code>
                    </p>
                    {tooLong && (
                        <p role="alert" className="text-[10px] text-amber-600 dark:text-amber-500">
                            {t('automations.form_wizard.per_item_name_too_long', 'The name of this question is too long to repeat. Use at most {max} characters.', { max: PER_ITEM_NAME_MAX })}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}
