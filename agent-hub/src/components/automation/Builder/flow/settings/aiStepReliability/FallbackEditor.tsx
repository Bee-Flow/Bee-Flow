import { useId, useState, type ComponentType } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { OnFocusField } from '@/components/automation/Builder/mapping/focusField.types';
import TemplateFieldJs from '@/components/automation/Builder/mapping/TemplateField';
import { FormRow, hintTextClass } from '../formPrimitives';
import { ProblemRing } from '../runProblem';
import { bindingFromText, textFromBinding, type Binding, type Fallback } from './reliabilityModel';

// A JavaScript component whose props TypeScript infers from their defaults.
const TemplateField = TemplateFieldJs;

interface OutputFieldRow { key: string; type?: string }

interface Props {
    fallback: Fallback | null;
    outputFields: OutputFieldRow[];
    onChange: (next: Fallback | null) => void;
    problem?: string | null;
    previewSample?: unknown;
    onFocusField?: OnFocusField | null;
}

/**
 * What the step does when the answer still fails its checks after one
 * automatic retry: stop the run with an error (the default, which an error
 * branch can catch), or carry on with values the author chose.
 */
export function FallbackEditor({ fallback, outputFields, onChange, problem = null, previewSample = null, onFocusField = null }: Props) {
    const { t } = useTranslation();
    const name = useId();
    const useValues = fallback?.kind === 'value';
    const fields: Record<string, Binding> = fallback?.kind === 'value' ? fallback.fields : {};
    // What is typed, kept apart from the stored binding: "1." is the number 1
    // once stored, and echoing that back would erase the dot under the caret.
    const [typed, setTyped] = useState<Record<string, string>>({});
    const rows = outputFields.filter(f => f && typeof f.key === 'string' && f.key.trim());

    const setValue = (key: string, type: string | undefined, raw: string) => {
        setTyped(prev => ({ ...prev, [key]: raw }));
        const next = { ...fields };
        const binding = bindingFromText(raw, type);
        if (binding) next[key] = binding; else delete next[key];
        onChange({ kind: 'value', fields: next });
    };

    return (
        <ProblemRing problem={problem}>
            <FormRow
                label={t('ai_step_checks.fallback_label', 'If the answer still fails after one automatic retry')}
                hint={t('ai_step_checks.fallback_hint', 'When an answer fails a check, the AI is asked once more with a note about what was wrong. If it still fails, the step either stops with an error (you can send that to an error branch) or carries on with the values you give here, and the run is marked with a warning.')}
            >
                <div className="space-y-1.5">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                        <input type="radio" name={name} checked={!useValues} onChange={() => { setTyped({}); onChange({ kind: 'fail' }); }} />
                        {t('ai_step_checks.fallback_fail', 'Stop the run with an error (default)')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                        <input type="radio" name={name} checked={useValues} onChange={() => onChange({ kind: 'value', fields })} />
                        {t('ai_step_checks.fallback_values', 'Use these values instead')}
                    </label>
                </div>
            </FormRow>
            {useValues && (
                <div className="space-y-2 pt-1">
                    {rows.length === 0 && (
                        <p className={hintTextClass()}>
                            {t('ai_step_checks.fallback_no_fields', 'Add fields under Structured output first: the values you give here fill those fields.')}
                        </p>
                    )}
                    {rows.map(f => (
                        <FormRow key={f.key} label={f.key} hint={t('ai_step_checks.fallback_value_hint', 'Used for this field when the answer fails. Type a fixed value, or drop in data from an earlier step with the {} button. Leave it empty to leave the field out.')}>
                            <TemplateField
                                value={typed[f.key] ?? textFromBinding(fields[f.key])}
                                onChange={(raw: string) => setValue(f.key, f.type, raw)}
                                multiline={false}
                                inline
                                ariaLabel={t('ai_step_checks.fallback_value_aria', 'Fallback value for {field}', { field: f.key })}
                                onFocusField={onFocusField}
                                previewSample={previewSample}
                                placeholder={t('ai_step_checks.fallback_value_placeholder', 'A fixed value')}
                            />
                        </FormRow>
                    ))}
                </div>
            )}
        </ProblemRing>
    );
}
