import { Check, Lock } from 'lucide-react';
import React from 'react';

/**
 * One cell of the kinds matrix: a real checkbox, named by row AND column
 * ("Person names — Outside tools"), so a screen reader hears both
 * coordinates. The visible box is drawn beside the visually hidden input.
 *
 * `locked` is the Enterprise-only column on a plan without it. There is no
 * stored value to show either way (the server clamps that list to [] on read
 * and on write), so the cell carries a lock instead of a box that invites a
 * click that would not stick.
 */
export default function MatrixCell({
    checked, disabled, locked, name, onChange,
}: {
    checked: boolean;
    disabled?: boolean;
    locked?: boolean;
    name: string;
    onChange: (on: boolean) => void;
}) {
    if (locked) {
        return (
            <span
                className="grid place-items-center w-4 h-4 rounded-[4px] border border-[var(--border-default)] bg-[var(--bg-tertiary)] opacity-50"
                title={name}
            >
                <Lock className="w-[9px] h-[9px] text-[var(--text-tertiary)]" aria-hidden="true" />
            </span>
        );
    }
    return (
        <label className={`relative grid place-items-center w-4 h-4 ${disabled ? 'cursor-default' : 'cursor-pointer'}`}>
            <input
                type="checkbox"
                className="sr-only peer"
                checked={checked}
                disabled={disabled}
                onChange={e => onChange(e.target.checked)}
                aria-label={name}
            />
            <span
                aria-hidden="true"
                className={'w-4 h-4 rounded-[4px] grid place-items-center box-border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--accent-primary)] peer-focus-visible:ring-offset-1 '
                    + (checked
                        ? 'bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)]'
                        : 'border-[1.5px] border-[var(--border-default)] bg-[var(--bg-card)]')
                    + (disabled ? ' opacity-50' : '')}
            >
                {checked && <Check className="w-3 h-3" strokeWidth={3} aria-hidden="true" />}
            </span>
        </label>
    );
}
