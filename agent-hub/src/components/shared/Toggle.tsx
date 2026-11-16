import React from 'react';

/**
 * Toggle — the one on/off switch, with optional title + description on the left.
 *
 * Supersedes the 50+ hand-rolled "label + hidden checkbox + peer-classed
 * div" rows scattered across admin panels (BehaviorSection, AITasksDesigner,
 * IntegrationsAdminPanel, GuardrailsPanel, etc.). Existing `ConfigToggle`
 * is a different visual idiom (visible checkbox row) and continues to be
 * used where that style is intentional.
 *
 * Three render modes:
 *   1. With `label` → a row of its own: { title, description? } | switch,
 *      on the settings surface (bg-primary, default border).
 *   2. With `label` and `flat` → the same row without a surface, for use as a
 *      row inside a card (a SettingsList, a Section): the card draws the frame.
 *   3. Without `label` → bare switch for inline use (table cells, headers).
 *
 * Colours are theme tokens only. ON is the theme's ink (`--text-primary`)
 * with a page-coloured knob, OFF is the off track (`--control-track-off`,
 * the default border) with a bordered knob: with the default grey accent an
 * accent-coloured track would barely differ from an off one. The control is
 * a checkbox with role="switch", so a screen reader says "switch, on".
 */

/**
 * @deprecated Every value draws the same token-coloured switch. Kept so the
 * callers that still pass a colour compile; drop it when you touch one.
 */
type ToggleColor = 'emerald' | 'amber' | 'rose' | 'sky';
type ToggleSize = 'sm' | 'md' | 'lg';

export interface ToggleProps {
    checked: boolean;
    onChange: (next: boolean) => void;
    label?: React.ReactNode;
    description?: React.ReactNode;
    /** @deprecated See ToggleColor: ignored. */
    color?: ToggleColor;
    disabled?: boolean;
    size?: ToggleSize;
    id?: string;
    /** Falls back to `label` (when it's a string) for screen readers. */
    ariaLabel?: string;
    /** Row mode only: no surface or border of its own, for a row inside a card. */
    flat?: boolean;
    /** Extra classes applied to the outer wrapper (row mode) or the label (bare mode). */
    className?: string;
}

// Tailwind needs the literal class strings in the source to keep them in the
// final CSS. Keep these maps in one place per visual concern.
const SIZE_TRACK: Record<ToggleSize, string> = {
    sm: 'w-9 h-5',
    md: 'w-11 h-6',
    lg: 'w-14 h-7',
};

const SIZE_KNOB: Record<ToggleSize, string> = {
    sm: 'after:h-4 after:w-4',
    md: 'after:h-5 after:w-5',
    lg: 'after:h-6 after:w-6',
};

/** Track and knob; `peer-*` follows the sr-only input before it. */
const SWITCH_TRACK =
    'relative block shrink-0 rounded-full transition-colors bg-[var(--control-track-off)] peer-checked:bg-[var(--text-primary)] ' +
    'peer-focus-visible:ring-2 peer-focus-visible:ring-[var(--focus-ring)] peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-[var(--bg-primary)] ' +
    "after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:rounded-full after:shadow-sm after:transition-transform " +
    'after:bg-[var(--control-knob)] after:border after:border-[var(--border-default)] ' +
    'peer-checked:after:translate-x-full peer-checked:after:border-transparent';

function Switch({
    checked,
    onChange,
    size = 'md',
    disabled = false,
    id,
    ariaLabel,
}: Pick<ToggleProps, 'checked' | 'onChange' | 'size' | 'disabled' | 'id' | 'ariaLabel'>) {
    return (
        <span className={`relative inline-flex items-center ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
            <input
                id={id}
                type="checkbox"
                role="switch"
                checked={checked}
                aria-checked={checked}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked)}
                aria-label={ariaLabel}
                className="sr-only peer"
            />
            <span aria-hidden="true" className={`${SIZE_TRACK[size]} ${SIZE_KNOB[size]} ${SWITCH_TRACK}`} />
        </span>
    );
}

const ROW_SURFACE = 'p-4 rounded-lg bg-[var(--bg-primary)] border border-[var(--border-default)]';
const ROW_FLAT = 'px-4 py-3';

export default function Toggle({
    checked,
    onChange,
    label,
    description,
    size = 'md',
    disabled = false,
    id,
    ariaLabel,
    flat = false,
    className = '',
}: ToggleProps) {
    // Bare switch — no label/description, just the control.
    if (label == null && description == null) {
        return (
            <label className={className}>
                <Switch
                    checked={checked}
                    onChange={onChange}
                    size={size}
                    disabled={disabled}
                    id={id}
                    ariaLabel={ariaLabel}
                />
            </label>
        );
    }

    const computedAria = ariaLabel ?? (typeof label === 'string' ? label : undefined);
    const rowClasses =
        `flex items-center justify-between gap-4 ${flat ? ROW_FLAT : ROW_SURFACE}` +
        (disabled ? ' opacity-60' : '') +
        (className ? ` ${className}` : '');

    return (
        <label htmlFor={id} className={rowClasses}>
            <div className="min-w-0">
                {label != null && (
                    <h4 className="m-0 text-[13px] font-medium text-[var(--text-primary)] truncate">{label}</h4>
                )}
                {description != null && (
                    <p className="m-0 mt-0.5 text-xs text-[var(--text-secondary)]">{description}</p>
                )}
            </div>
            <Switch
                checked={checked}
                onChange={onChange}
                size={size}
                disabled={disabled}
                id={id}
                ariaLabel={computedAria}
            />
        </label>
    );
}
