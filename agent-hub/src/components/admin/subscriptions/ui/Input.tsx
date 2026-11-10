import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

import { INPUT } from '@/components/mcpLibrary/ui';

// The console's form controls on the shared INPUT recipe; Field adds the
// label-with-inline-hint and the error line its forms use.
const baseClass = INPUT;

interface FieldProps {
    label?: ReactNode;
    hint?: ReactNode;
    error?: ReactNode;
    children?: ReactNode;
    className?: string;
}

export function Field({ label, hint, error, children, className = '' }: FieldProps) {
    return (
        <div className={className}>
            {label && (
                <label className="mb-1 block text-[12px] font-medium text-[var(--text-secondary)]">
                    {label}
                    {hint && <span className="ml-1 text-[11px] font-normal text-[var(--text-tertiary)]">— {hint}</span>}
                </label>
            )}
            {children}
            {error && <p className="mt-1 text-[11px] text-[var(--error-ink)]">{error}</p>}
        </div>
    );
}

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
    return <input className={`${baseClass} ${className}`} {...rest} />;
}

export function Textarea({ className = '', rows = 3, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea rows={rows} className={`${baseClass} resize-y ${className}`} {...rest} />;
}

export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select className={`${baseClass} cursor-pointer pr-8 ${className}`} {...rest}>
            {children}
        </select>
    );
}

interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> {
    value?: number | string | null;
    onChange: (value: number | null) => void;
    allowDecimal?: boolean;
}

export function NumberInput({ value, onChange, step = 1, min, max, placeholder = 'Unlimited', className = '', allowDecimal = false, ...rest }: NumberInputProps) {
    return (
        <input
            type="number"
            inputMode={allowDecimal ? 'decimal' : 'numeric'}
            step={step}
            min={min}
            max={max}
            placeholder={placeholder}
            value={value ?? ''}
            onChange={e => {
                const v = e.target.value;
                if (v === '') return onChange(null);
                const parsed = allowDecimal ? parseFloat(v) : parseInt(v, 10);
                onChange(Number.isFinite(parsed) ? parsed : null);
            }}
            className={`${baseClass} ${className}`}
            {...rest}
        />
    );
}
