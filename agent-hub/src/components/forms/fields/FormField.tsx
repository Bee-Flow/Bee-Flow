import React from 'react';
import useTranslation from '@/hooks/useTranslation';
import { Field, INPUT_CLASS, inputStyle } from '../../admin/Studio/AppStudio/runtime/uiBits';
import { normaliseOptions } from '../formOptions';
import type { AppPick, FormChangeHandler, FormErrorHandler, FormFieldProps, FormUpload } from '../PublicFormRenderer.types';
import AppPickField from './AppPickField';
import { MultiSelectField, RadioField } from './ChoiceFields';
import { FormDownload, FormOpenInNotebooks } from './DownloadFields';
import FileField from './FileField';
import InfoField from './InfoField';

const HELP_CLASS = 'text-xs text-[var(--text-muted)]';

/** The ids that tie a control to its error and its help text. */
function describedByOf(id: string, error: string | null | undefined, help: string | undefined): string | undefined {
    return [error ? `${id}-error` : null, help ? `${id}-help` : null].filter(Boolean).join(' ') || undefined;
}

function CheckboxField({ field, value, error, disabled, onChange }: FormFieldProps) {
    const id = `ff_${field.name}`;
    return (
        <div className="flex flex-col gap-1 text-left">
            <label htmlFor={id} className="flex items-start gap-2 text-sm cursor-pointer text-[var(--text-primary)]">
                <input
                    id={id}
                    name={field.name}
                    type="checkbox"
                    disabled={disabled}
                    checked={value === true}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={describedByOf(id, error, field.help)}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => (onChange as FormChangeHandler)(e.target.checked)}
                    className="mt-0.5 accent-[var(--app-primary)]"
                />
                <span>
                    {field.label}
                    {field.required ? <span aria-hidden="true" className="text-[#ef4444]"> *</span> : null}
                </span>
            </label>
            {field.help ? <p id={`${id}-help`} className={HELP_CLASS}>{field.help}</p> : null}
            {error ? <p id={`${id}-error`} className="text-xs text-[#ef4444]" role="alert">{error}</p> : null}
        </div>
    );
}

/** The single-line and list controls that share one `<Field>` frame: text, textarea, select, number, date, email. */
function TextLikeControl({ field, value, error, disabled, onChange, onBlur }: FormFieldProps) {
    const { t } = useTranslation();
    const id = `ff_${field.name}`;
    const change = onChange as FormChangeHandler;
    const common = {
        id,
        name: field.name,
        disabled,
        className: INPUT_CLASS,
        style: inputStyle(!!error),
        onBlur,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': describedByOf(id, error, field.help),
    };
    if (field.type === 'textarea') {
        return <textarea {...common} rows={5} value={(value || '') as string} placeholder={field.placeholder} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => change(e.target.value)} />;
    }
    if (field.type === 'select') {
        return (
            <select {...common} disabled={disabled || field.noOptions} value={(value || '') as string} onChange={(e: React.ChangeEvent<HTMLSelectElement>) => change(e.target.value)}>
                <option value="">{field.placeholder || t('forms.choose', 'Choose…')}</option>
                {normaliseOptions(field.options).map(o => <option key={o.value} value={o.value} title={o.hint || undefined}>{o.label}</option>)}
            </select>
        );
    }
    const bounded = field.type === 'number' || field.type === 'date';
    return (
        <input
            {...common}
            type={field.type === 'email' ? 'email' : bounded ? field.type : 'text'}
            value={(value ?? '') as string}
            placeholder={field.placeholder}
            min={bounded ? field.min : undefined}
            max={bounded ? field.max : undefined}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => change(e.target.value)}
        />
    );
}

/**
 * One question (or display-only block) of a form.
 *
 * Which control a type gets is decided here and nowhere else. The page owns
 * the state: this takes a `value`, reports a change, and shows the `error`
 * the page hands it, tied to its control with aria-invalid + aria-describedby.
 */
export default function FormField(props: FormFieldProps) {
    const { t } = useTranslation();
    const { field, value, error = null, disabled, onChange, onUpload, onSearchApp, onError, onBlur, downloadHref, onOpenInNotebooks } = props;
    const change = onChange as FormChangeHandler;
    const choice = { field, value, error, disabled, onChange: change, onBlur };

    // A download is the one field that GIVES rather than asks: the automation made
    // a document and this hands it over. It collects nothing, so it has no
    // value, no error and no place in the submission.
    switch (field.type) {
        case 'download': return <FormDownload field={field} href={downloadHref} />;
        case 'notebook': return <FormOpenInNotebooks field={field} onOpen={onOpenInNotebooks} />;
        case 'info': return <InfoField field={field} />;
        case 'radio': return <RadioField {...choice} />;
        case 'multiselect': return <MultiSelectField {...choice} />;
        case 'checkbox': return <CheckboxField {...props} />;
        default: break;
    }

    const id = `ff_${field.name}`;
    return (
        <Field id={id} label={field.label} required={field.required && !field.noOptions} error={error}>
            {field.type === 'file' ? (
                <FileField field={field} value={value as FormUpload | null} disabled={disabled} onChange={change} onUpload={onUpload} onError={onError as FormErrorHandler} />
            ) : field.type === 'app_pick' ? (
                <AppPickField field={field} value={value as AppPick | AppPick[] | null} disabled={disabled} onChange={change} onSearch={onSearchApp} />
            ) : (
                <TextLikeControl {...props} error={error} />
            )}
            {field.type === 'select' && field.noOptions ? <p className={HELP_CLASS}>{t('forms.no_options', 'No choices available.')}</p> : null}
            {field.help ? <p id={`${id}-help`} className={HELP_CLASS}>{field.help}</p> : null}
        </Field>
    );
}
