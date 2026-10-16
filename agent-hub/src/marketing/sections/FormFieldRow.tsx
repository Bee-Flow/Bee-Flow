import React from 'react';
import type { FormField } from './formBlockModel';

interface Props {
    field: FormField;
    inputId: string;
    value: string | boolean | undefined;
    error?: string;
    onChange: (value: string | boolean) => void;
}

/** One field of a website form: label, control and its error, wired for assistive tech. */
export default function FormFieldRow({ field: f, inputId, value, error, onChange }: Props) {
    const common = {
        id: inputId,
        name: f.id,
        'aria-required': f.required || undefined,
        'aria-invalid': error ? true : undefined,
        'aria-describedby': error ? `${inputId}-err` : undefined,
    } as const;
    const text = String(value ?? '');
    const label = `${f.label || f.id}${f.required ? ' *' : ''}`;
    const errorNode = error ? <p id={`${inputId}-err`} className="cms-form-error" role="alert">{error}</p> : null;

    if (f.type === 'checkbox') {
        return (
            <div className="cms-form-row cms-form-row--check">
                <input {...common} type="checkbox" checked={value === true} onChange={e => onChange(e.target.checked)} />
                <label htmlFor={inputId}>{label}</label>
                {errorNode}
            </div>
        );
    }
    return (
        <div className="cms-form-row">
            <label htmlFor={inputId} className="cms-form-label">{label}</label>
            {f.type === 'textarea' ? (
                <textarea {...common} className="cms-form-input" rows={4} placeholder={f.placeholder} value={text} onChange={e => onChange(e.target.value)} />
            ) : f.type === 'select' ? (
                <select {...common} className="cms-form-input" value={text} onChange={e => onChange(e.target.value)}>
                    <option value="">{f.placeholder || ''}</option>
                    {(f.options || []).map(o => <option key={o.value} value={o.value}>{o.label || o.value}</option>)}
                </select>
            ) : (
                <input {...common} className="cms-form-input" type={f.type === 'email' ? 'email' : 'text'}
                    autoComplete={f.type === 'email' ? 'email' : undefined} placeholder={f.placeholder}
                    value={text} onChange={e => onChange(e.target.value)} />
            )}
            {errorNode}
        </div>
    );
}
