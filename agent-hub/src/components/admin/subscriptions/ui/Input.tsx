import React from 'react';
import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const baseClass = 'w-full px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] text-[13px] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50';

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
                <label className="block text-[12px] font-medium text-[var(--text-secondary)] mb-1">
                    {label}
                    {hint && <span className="ml-1 text-[10px] font-normal text-[var(--text-muted)]">— {hint}</span>}
                </label>
            )}
            {children}
            {error && <p className="mt-1 text-[11px] text-rose-400">{error}</p>}
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
