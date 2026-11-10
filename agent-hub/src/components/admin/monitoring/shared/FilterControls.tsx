import type { ReactNode } from 'react';
import { ChevronDown, Search, type LucideIcon } from 'lucide-react';

// The filter row of the monitor's pages: a search box and icon-led selects on
// the input tokens, so every page filters with the same controls.

const FIELD = 'flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs transition-colors';
const FIELD_IDLE = 'border-[var(--border-default)] bg-[var(--bg-primary)] text-[var(--text-secondary)]';
const FIELD_ON = 'border-[var(--text-tertiary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]';

interface SearchFieldProps {
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    className?: string;
}

export function SearchField({ value, onChange, placeholder, className = '' }: SearchFieldProps) {
    return (
        <label className={`${FIELD} ${FIELD_IDLE} focus-within:border-[var(--accent-primary)] ${className}`}>
            <Search className="h-3 w-3 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <input
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                aria-label={placeholder}
                className="w-full min-w-0 bg-transparent text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)]"
            />
        </label>
    );
}

interface SelectFieldProps {
    icon: LucideIcon;
    value: string;
    onChange: (value: string) => void;
    /** The accessible name; the first option says the same to a sighted reader. */
    label: string;
    children: ReactNode;
}

export function SelectField({ icon: Icon, value, onChange, label, children }: SelectFieldProps) {
    return (
        <div className={`relative ${FIELD} ${value ? FIELD_ON : FIELD_IDLE}`}>
            <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                aria-label={label}
                className="min-w-[60px] cursor-pointer appearance-none bg-transparent pr-4 font-medium text-inherit outline-none"
            >
                {children}
            </select>
            <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 opacity-60" aria-hidden="true" />
        </div>
    );
}

/** The filter row: controls on the left, the count of what is left on the right. */
export function FilterRow({ children, count }: { children: ReactNode; count?: ReactNode }) {
    return (
        <div className="flex flex-wrap items-center gap-2">
            {children}
            {count != null && <span className="ml-auto text-[11px] tabular-nums text-[var(--text-tertiary)]">{count}</span>}
        </div>
    );
}
