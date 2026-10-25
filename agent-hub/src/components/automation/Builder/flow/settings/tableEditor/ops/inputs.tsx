import { Plus, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from '../../../../../../../hooks/useTranslation';
import { actionButtonClass, rowInputClass } from '../../formStyles';

/** The small controls the operation forms share. */

interface TextProps { value: string; onChange: (v: string) => void; ariaLabel: string; id?: string; invalid?: boolean; placeholder?: string }

export function TextInput({ value, onChange, ariaLabel, id, invalid, placeholder }: TextProps) {
    return <input id={id} type="text" value={value} onChange={e => onChange(e.target.value)} aria-label={ariaLabel} placeholder={placeholder} className={rowInputClass('w-full', { invalid })} />;
}

interface NumberProps {
    value: number | null | undefined; onChange: (v: number | null) => void; ariaLabel: string;
    id?: string; min?: number; max?: number; step?: number; placeholder?: string; invalid?: boolean;
}

/**
 * A number; empty is null. What is typed stays as typed (an emptied box stays
 * empty while the form holds its fallback) until the box loses focus.
 */
export function NumberInput({ value, onChange, ariaLabel, id, min, max, step, placeholder, invalid }: NumberProps) {
    const [text, setText] = useState<string | null>(null);
    const shown = text !== null && (text === '' || Number(text) === value) ? text : String(value ?? '');
    return (
        <input
            id={id} type="number" value={shown} min={min} max={max} step={step} placeholder={placeholder} aria-label={ariaLabel}
            onChange={e => {
                setText(e.target.value);
                const n = e.target.value === '' ? null : Number(e.target.value);
                onChange(n !== null && Number.isFinite(n) ? n : null);
            }}
            onBlur={() => setText(null)}
            className={rowInputClass('w-full', { invalid })}
        />
    );
}

interface ChoiceProps<T extends string> { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string; id?: string }

export function Choice<T extends string>({ value, options, onChange, ariaLabel, id }: ChoiceProps<T>) {
    return (
        <select id={id} value={value} aria-label={ariaLabel} onChange={e => onChange(e.target.value as T)} className={rowInputClass('w-full')}>
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    );
}

interface RadiosProps<T extends string> { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }

export function Radios<T extends string>({ value, options, onChange, ariaLabel }: RadiosProps<T>) {
    return (
        <div role="radiogroup" aria-label={ariaLabel} className="flex flex-col gap-1 text-xs text-[var(--text-primary)]">
            {options.map(o => (
                <label key={o.value} className="flex items-center gap-2">
                    <input type="radio" checked={value === o.value} onChange={() => onChange(o.value)} />
                    {o.label}
                </label>
            ))}
        </div>
    );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
    return (
        <label className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
            <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
            {label}
        </label>
    );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
    return (
        <button type="button" onClick={onClick} className={`${actionButtonClass()} self-start`}>
            <Plus size={12} /> {children}
        </button>
    );
}

function RemoveButton({ onClick, label }: { onClick: () => void; label: string }) {
    return (
        <button type="button" onClick={onClick} aria-label={label} title={label} className="shrink-0 rounded p-1 text-[var(--text-tertiary)] hover:text-[var(--error)]">
            <Trash2 size={13} />
        </button>
    );
}

const parseList = (text: string): string[] => text.split(',').map(s => s.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** A comma-separated list in one box. What is typed stays as typed while it is a valid way of writing the list. */
export function ListInput({ value, onChange, ariaLabel, id, placeholder, invalid }: {
    value: string[]; onChange: (v: string[]) => void; ariaLabel: string; id?: string; placeholder?: string; invalid?: boolean;
}) {
    const [text, setText] = useState(value.join(', '));
    const shown = sameList(parseList(text), value) ? text : value.join(', ');
    return (
        <input
            id={id} type="text" value={shown} placeholder={placeholder} aria-label={ariaLabel}
            onChange={e => { setText(e.target.value); onChange(parseList(e.target.value)); }}
            className={rowInputClass('w-full', { invalid })}
        />
    );
}

/** A box with one value per line. */
export function LinesInput({ value, onChange, ariaLabel, id, invalid }: { value: string[]; onChange: (v: string[]) => void; ariaLabel: string; id?: string; invalid?: boolean }) {
    const [text, setText] = useState(value.join('\n'));
    const parse = (s: string) => s.split('\n').map(x => x.trim()).filter(Boolean);
    const shown = sameList(parse(text), value) ? text : value.join('\n');
    return (
        <textarea
            id={id} rows={3} value={shown} aria-label={ariaLabel}
            onChange={e => { setText(e.target.value); onChange(parse(e.target.value)); }}
            className={rowInputClass('w-full resize-y', { invalid })}
        />
    );
}

/** A row of a list of settings, with its remove button. */
export function Row({ children, onRemove, removeLabel }: { children: ReactNode; onRemove?: () => void; removeLabel: string }) {
    return (
        <div className="flex items-start gap-1.5 rounded border border-[var(--border-default)] p-1.5">
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">{children}</div>
            {onRemove && <RemoveButton onClick={onRemove} label={removeLabel} />}
        </div>
    );
}
