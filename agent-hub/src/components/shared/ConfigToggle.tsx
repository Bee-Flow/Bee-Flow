import React from 'react';

interface ConfigToggleProps {
    /** Unique id for the checkbox */
    id?: string;
    label?: React.ReactNode;
    /** Optional description text below the label */
    description?: React.ReactNode;
    /** Optional emoji icon shown before label */
    icon?: React.ReactNode;
    checked?: boolean;
    /** Called with the new boolean value */
    onChange: (checked: boolean) => void;
}

/**
 * Reusable config toggle (checkbox + label + description).
 * Replaces 20+ identical inline checkbox patterns across manager pages and admin panels.
 */
export default function ConfigToggle({ id, label, description, icon, checked, onChange }: ConfigToggleProps) {
    return (
        <label
            htmlFor={id}
            className="flex items-start gap-3 px-4 py-3 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
        >
            <input
                id={id}
                type="checkbox"
                checked={checked}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.checked)}
                className="accent-[var(--accent-primary)] mt-1 flex-shrink-0"
            />
            <div className="flex-1">
                <div className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)]">
                    {icon && <span>{icon}</span>}
                    {label}
                </div>
                {description && (
                    <p className="text-xs mt-0.5 text-[var(--text-muted)]">{description}</p>
                )}
            </div>
        </label>
    );
}
