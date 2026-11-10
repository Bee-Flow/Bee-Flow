import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { INPUT_CLS } from '../../inspector/panels/kit';
import type { FieldSpec } from '../StepSettings.types';

/**
 * A plain text field longer than this is written in a multi-line box. The AI step's prompt may
 * hold 32,000 characters (LIMITS.MAX_AI_PROMPT_LEN), and a single-line input showed one sliver of
 * it; every short string (a variable name, a file name, a pattern) stays a single line.
 */
const MULTILINE_MIN_LEN = 500;

/** True for a string field whose limit is long enough to be prose. */
export function isLongText(fs: FieldSpec): boolean {
    return fs.type === 'string' && typeof fs.maxLen === 'number' && fs.maxLen > MULTILINE_MIN_LEN;
}

interface LongTextFieldProps {
    label: string;
    hint?: string;
    value: unknown;
    onChange: (next: unknown) => void;
    maxLen?: number;
    required: boolean;
    nullable: boolean;
    disabled: boolean;
}

/** The multi-line box, with the count against the limit so a cut never comes as a surprise. */
export default function LongTextField({ label, hint, value, onChange, maxLen, required, nullable, disabled }: LongTextFieldProps) {
    const { t } = useTranslation();
    const text = typeof value === 'string' ? value : '';
    return (
        <FormField label={label} hint={hint}>
            <textarea
                className={`${INPUT_CLS} min-h-[120px] resize-y font-mono text-xs leading-relaxed`}
                rows={8}
                value={text}
                onChange={(e) => onChange(e.target.value || (nullable ? null : ''))}
                placeholder={required ? t('studio_apps_edit.step_settings.required', 'Required') : undefined}
                maxLength={maxLen}
                disabled={disabled}
                aria-label={label}
                data-long-text="true"
            />
            {maxLen ? (
                <span className="mt-1 block text-right text-[11px] text-[var(--text-secondary)]">
                    {t('studio_apps_step_fields.long_text.count', '{count} of {max} characters', { count: text.length.toLocaleString(), max: maxLen.toLocaleString() })}
                </span>
            ) : null}
        </FormField>
    );
}
