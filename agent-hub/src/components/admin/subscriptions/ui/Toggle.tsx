import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// The console's switch, kept local: it is a real `role="switch"` button
// (FeatureCardGrid.test.tsx and the plan editor's screen-reader output rely on
// that), where the shared Toggle is a checkbox, and its labelled form is a
// settings row with a leading icon, which the shared one has no slot for.

interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    label?: ReactNode;
    description?: ReactNode;
    icon?: LucideIcon;
}

export function Toggle({ checked, onChange, disabled = false, label, description, icon: Icon }: ToggleProps) {
    const inner = (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => !disabled && onChange(!checked)}
            className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)] ${
                checked ? 'bg-[var(--success)]' : 'border border-[var(--border-default)] bg-[var(--bg-tertiary)]'
            } ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
        >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
        </button>
    );

    if (!label && !description) return inner;

    return (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] px-4 py-3">
            <div className="min-w-0">
                <div className="flex items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                    {Icon && <Icon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />}
                    <span>{label}</span>
                </div>
                {description && <p className="m-0 mt-0.5 text-xs leading-relaxed text-[var(--text-tertiary)]">{description}</p>}
            </div>
            {inner}
        </div>
    );
}

interface CheckboxProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: ReactNode;
    disabled?: boolean;
}

export function Checkbox({ checked, onChange, label, disabled = false }: CheckboxProps) {
    return (
        <label className={`inline-flex items-center gap-2 text-[13px] text-[var(--text-primary)] ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
            <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={e => onChange(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent-primary)]"
            />
            <span>{label}</span>
        </label>
    );
}
