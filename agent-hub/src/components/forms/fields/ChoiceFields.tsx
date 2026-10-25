import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { normaliseOptions, type FormOption } from '../formOptions';
import type { FormFieldDef, FormValue } from '../PublicFormRenderer.types';

/**
 * The two closed-choice questions that show ALL their options at once:
 *
 *   • radio       — exactly one option; the answer is that option's VALUE.
 *   • multiselect — any number of options; the answer is a list of VALUES.
 *
 * What travels with the submission is always the option's value, never the
 * label the visitor read: the server checks it against the declared list.
 * An option's `hint` is a short secondary line under its label, and is tied to
 * the input with aria-describedby so a screen reader reads it too.
 */

interface ChoiceProps {
    field: FormFieldDef;
    value: FormValue;
    error: string | null;
    disabled?: boolean;
    onChange: (value: FormValue) => void;
    onBlur?: () => void;
}

const ERROR_TEXT = 'text-xs text-[var(--error)]';
const HELP_TEXT = 'text-xs text-[var(--text-muted)]';
const OPTION_ROW = 'flex items-start gap-2 text-sm cursor-pointer text-[var(--text-primary)]';

/** "Choose up to 3" / "Choose at least 2" / "Choose 2 to 4": what a multiselect asks for, or ''. */
function choiceCountHint(field: FormFieldDef, t: ReturnType<typeof useTranslation>['t']): string {
    const lo = typeof field.minSelected === 'number' && field.minSelected > 0 ? field.minSelected : null;
    const hi = typeof field.maxSelected === 'number' ? field.maxSelected : null;
    if (lo !== null && hi !== null) {
        return lo === hi
            ? t('forms.choose_exactly', 'Choose exactly {n}', { n: lo })
            : t('forms.choose_between', 'Choose {min} to {max}', { min: lo, max: hi });
    }
    if (hi !== null) return t('forms.choose_up_to', 'Choose up to {n}', { n: hi });
    if (lo !== null) return t('forms.choose_at_least', 'Choose at least {n}', { n: lo });
    return '';
}

/** The shell both share: a fieldset with the question as its legend, then the note, the options, help and error. */
function ChoiceShell({ field, error, role, onBlur, hint, children }: {
    field: FormFieldDef;
    error: string | null;
    role?: string;
    onBlur?: (e: React.FocusEvent<HTMLFieldSetElement>) => void;
    hint?: string;
    children: React.ReactNode;
}) {
    const { t } = useTranslation();
    const id = `ff_${field.name}`;
    const describedBy = [error ? `${id}-error` : null, field.help ? `${id}-help` : null, hint ? `${id}-count` : null].filter(Boolean).join(' ') || undefined;
    return (
        <fieldset
            id={id}
            role={role}
            aria-describedby={describedBy}
            aria-invalid={role === 'radiogroup' && error ? true : undefined}
            onBlur={onBlur}
            className="flex flex-col gap-1.5 text-left min-w-0 m-0 p-0 border-0"
        >
            <legend className="p-0 mb-1 text-sm font-medium text-[var(--text-primary)]">
                {field.label}
                {field.required && !field.noOptions ? <span aria-hidden="true" className="text-[var(--error)]"> *</span> : null}
            </legend>
            {hint ? <p id={`${id}-count`} className={HELP_TEXT}>{hint}</p> : null}
            {field.noOptions ? <p className={HELP_TEXT}>{t('forms.no_options', 'No choices available.')}</p> : children}
            {field.help ? <p id={`${id}-help`} className={HELP_TEXT}>{field.help}</p> : null}
            {error ? <p id={`${id}-error`} className={ERROR_TEXT} role="alert">{error}</p> : null}
        </fieldset>
    );
}

/** Focus left the whole group, not just one of its options. */
const leftGroup = (e: React.FocusEvent<HTMLFieldSetElement>): boolean => !e.currentTarget.contains(e.relatedTarget as Node | null);

function OptionText({ option, hintId }: { option: FormOption; hintId?: string }) {
    return (
        <span className="flex flex-col min-w-0">
            <span>{option.label}</span>
            {option.hint ? <span id={hintId} className={HELP_TEXT}>{option.hint}</span> : null}
        </span>
    );
}

export function RadioField({ field, value, error, disabled, onChange, onBlur }: ChoiceProps) {
    const options = normaliseOptions(field.options);
    const id = `ff_${field.name}`;
    return (
        <ChoiceShell field={field} error={error} role="radiogroup" onBlur={e => { if (onBlur && leftGroup(e)) onBlur(); }}>
            {options.map((o, i) => {
                const hintId = o.hint ? `${id}_${i}_hint` : undefined;
                return (
                    <label key={o.value} htmlFor={`${id}_${i}`} className={OPTION_ROW}>
                        <input
                            id={`${id}_${i}`}
                            type="radio"
                            name={field.name}
                            value={o.value}
                            disabled={disabled}
                            checked={value === o.value}
                            aria-describedby={hintId}
                            onChange={() => onChange(o.value)}
                            className="mt-0.5 accent-[var(--app-primary)]"
                        />
                        <OptionText option={o} hintId={hintId} />
                    </label>
                );
            })}
        </ChoiceShell>
    );
}

export function MultiSelectField({ field, value, error, disabled, onChange, onBlur }: ChoiceProps) {
    const { t } = useTranslation();
    const options = normaliseOptions(field.options);
    const id = `ff_${field.name}`;
    const picked = Array.isArray(value) ? (value as string[]) : [];
    const toggle = (v: string, on: boolean) => {
        const next = on ? [...picked, v] : picked.filter(p => p !== v);
        // Keep the order the question lists its choices in, whatever order they were ticked.
        onChange(options.map(o => o.value).filter(x => next.includes(x)));
    };
    return (
        <ChoiceShell field={field} error={error} hint={choiceCountHint(field, t)} onBlur={e => { if (onBlur && leftGroup(e)) onBlur(); }}>
            {options.map((o, i) => {
                const hintId = o.hint ? `${id}_${i}_hint` : undefined;
                return (
                    <label key={o.value} htmlFor={`${id}_${i}`} className={OPTION_ROW}>
                        <input
                            id={`${id}_${i}`}
                            type="checkbox"
                            name={field.name}
                            value={o.value}
                            disabled={disabled}
                            checked={picked.includes(o.value)}
                            aria-invalid={error ? true : undefined}
                            aria-describedby={hintId}
                            onChange={e => toggle(o.value, e.target.checked)}
                            className="mt-0.5 accent-[var(--app-primary)]"
                        />
                        <OptionText option={o} hintId={hintId} />
                    </label>
                );
            })}
        </ChoiceShell>
    );
}
