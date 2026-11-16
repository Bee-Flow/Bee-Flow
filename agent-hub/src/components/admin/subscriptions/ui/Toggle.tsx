import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import SharedToggle from '@/components/shared/Toggle';

// The console's switch: the shared Toggle (a checkbox with role="switch", the
// one switch of the dashboard), with the leading icon the console's labelled
// rows carry in front of the label.

interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled?: boolean;
    label?: ReactNode;
    description?: ReactNode;
    icon?: LucideIcon;
    /** The switch's name for a screen reader when it has no label of its own. */
    ariaLabel?: string;
}

export function Toggle({ checked, onChange, disabled = false, label, description, icon: Icon, ariaLabel }: ToggleProps) {
    if (!label && !description) {
        return <SharedToggle checked={checked} onChange={onChange} disabled={disabled} size="sm" ariaLabel={ariaLabel} />;
    }
    const title = Icon
        ? <span className="inline-flex items-center gap-2"><Icon className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />{label}</span>
        : label;
    return (
        <SharedToggle
            checked={checked} onChange={onChange} disabled={disabled} size="sm"
            label={title} description={description}
            ariaLabel={ariaLabel ?? (typeof label === 'string' ? label : undefined)}
        />
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
