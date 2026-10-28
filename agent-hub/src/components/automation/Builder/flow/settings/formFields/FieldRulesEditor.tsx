import { useState, type ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { denseInputClass } from '../formPrimitives';
import type { EditorField } from './fieldEditor.types';
import { RULE_TYPES, hasRules } from './fieldKinds';

type Change = (changes: Partial<EditorField>) => void;
interface RulesProps { field: EditorField; n: number; onChange: Change }

const LABEL = 'text-[10px] uppercase tracking-wide text-[var(--text-tertiary)]';
const WARN = 'text-[10px] text-amber-600 dark:text-amber-500';

const toCount = (v: string): number | undefined => (v === '' ? undefined : Math.max(0, Math.floor(Number(v)) || 0));
const toNumber = (v: string): number | undefined => (v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
const shown = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** Two labelled inputs side by side, with a warning underneath when the first is above the second. */
function RangeRow({ low, high, invalid }: { low: [string, ReactNode]; high: [string, ReactNode]; invalid: boolean }) {
    const { t } = useTranslation();
    return (
        <div className="space-y-0.5">
            <div className="flex items-center gap-2">
                <label className="flex-1 min-w-0 space-y-0.5"><span className={LABEL}>{low[0]}</span>{low[1]}</label>
                <label className="flex-1 min-w-0 space-y-0.5"><span className={LABEL}>{high[0]}</span>{high[1]}</label>
            </div>
            {invalid && <p role="alert" className={WARN}>{t('automations.form_wizard.rule_low_above_high', 'The lowest allowed is higher than the highest allowed, so nobody could answer.')}</p>}
        </div>
    );
}

function ValueRules({ field, n, onChange }: RulesProps) {
    const { t } = useTranslation();
    const date = field.type === 'date';
    const invalid = date
        ? !!field.min && !!field.max && String(field.min) > String(field.max)
        : shown(field.min) !== '' && shown(field.max) !== '' && Number(field.min) > Number(field.max);
    const input = (key: 'min' | 'max') => date
        ? <input type="date" aria-label={`Question ${n} ${key}`} value={typeof field[key] === 'string' ? (field[key] as string) : ''} onChange={(e) => onChange({ [key]: e.target.value || undefined })} className={denseInputClass('w-full')} />
        : <input type="number" aria-label={`Question ${n} ${key}`} value={shown(field[key])} onChange={(e) => onChange({ [key]: toNumber(e.target.value) })} className={denseInputClass('w-full')} />;
    return (
        <RangeRow
            low={[date ? t('automations.form_wizard.rule_min_date', 'Earliest date') : t('automations.form_wizard.rule_min_number', 'Lowest allowed'), input('min')]}
            high={[date ? t('automations.form_wizard.rule_max_date', 'Latest date') : t('automations.form_wizard.rule_max_number', 'Highest allowed'), input('max')]}
            invalid={invalid}
        />
    );
}

function LengthRules({ field, n, onChange }: RulesProps) {
    const { t } = useTranslation();
    const input = (key: 'minLength' | 'maxLength') => (
        <input type="number" min={0} aria-label={`Question ${n} ${key}`} value={shown(field[key])} onChange={(e) => onChange({ [key]: toCount(e.target.value) })} className={denseInputClass('w-full')} />
    );
    const invalid = field.minLength !== undefined && field.maxLength !== undefined && field.minLength > field.maxLength;
    return (
        <RangeRow
            low={[t('automations.form_wizard.rule_min_length', 'Fewest characters'), input('minLength')]}
            high={[t('automations.form_wizard.rule_max_length', 'Most characters'), input('maxLength')]}
            invalid={invalid}
        />
    );
}

function PatternRules({ field, n, onChange }: RulesProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1">
            <label className="block space-y-0.5">
                <span className={LABEL}>{t('automations.form_wizard.rule_pattern', 'Must match this pattern')}</span>
                <input
                    type="text"
                    maxLength={200}
                    aria-label={`Question ${n} pattern`}
                    value={field.pattern || ''}
                    onChange={(e) => onChange({ pattern: e.target.value || undefined, ...(e.target.value ? {} : { patternMessage: undefined }) })}
                    className={denseInputClass('w-full font-mono')}
                    placeholder="[A-Z]{2}[0-9]{4}"
                />
            </label>
            <p className="text-[10px] text-[var(--text-tertiary)]">
                {t('automations.form_wizard.rule_pattern_help', 'The whole answer has to fit the pattern, e.g. [A-Z]{2}[0-9]{4} accepts AB1234. Leave empty to accept anything.')}
            </p>
            {field.pattern && (
                <label className="block space-y-0.5">
                    <span className={LABEL}>{t('automations.form_wizard.rule_pattern_message', 'Message when it does not fit')}</span>
                    <input
                        type="text"
                        maxLength={120}
                        aria-label={`Question ${n} pattern message`}
                        value={field.patternMessage || ''}
                        onChange={(e) => onChange({ patternMessage: e.target.value || undefined })}
                        className={denseInputClass('w-full')}
                        placeholder={t('automations.form_wizard.rule_pattern_message_placeholder', 'Use two letters followed by four digits.')}
                    />
                </label>
            )}
        </div>
    );
}

/**
 * "Answer rules": the limits a question puts on what can be typed. Collapsed
 * until the question has a rule, because most questions need none. Each rule
 * is optional and is only checked on an answer that was given.
 */
export default function FieldRulesEditor({ field, index, onChange }: { field: EditorField; index: number; onChange: Change }) {
    const { t } = useTranslation();
    const type = field.type || 'text';
    const [open, setOpen] = useState(() => hasRules(field));
    if (!RULE_TYPES.includes(type)) return null;
    const props = { field, n: index + 1, onChange };
    return (
        <div className="space-y-1.5">
            <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpen(v => !v)}
                className="text-[10px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
            >
                {open ? t('automations.form_wizard.hide_rules', 'Hide answer rules') : t('automations.form_wizard.show_rules', 'Answer rules')}
            </button>
            {open && (
                <div className="space-y-1.5">
                    <p className="text-[10px] text-[var(--text-tertiary)]">
                        {t('automations.form_wizard.rules_help', 'Optional limits on the answer. They are only checked when something was answered.')}
                    </p>
                    {(type === 'number' || type === 'date') && <ValueRules {...props} />}
                    {(type === 'text' || type === 'textarea' || type === 'email') && <LengthRules {...props} />}
                    {(type === 'text' || type === 'textarea') && <PatternRules {...props} />}
                </div>
            )}
        </div>
    );
}
