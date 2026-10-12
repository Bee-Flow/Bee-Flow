import React from 'react';

/**
 * Small presentational atoms shared by the org-level (admin) and personal
 * (settings) Meeting Notes panels (Nextcloud Talk, Google Meet, Teams), which
 * re-declared them byte-for-byte. Keep purely presentational — the panels own
 * their own data.
 *
 * Colours come from the theme: a switch that is on uses the accent, like every
 * other switch in Settings. NC_BLUE is the Nextcloud brand colour, kept for the
 * Talk header icon only.
 */

export const NC_BLUE = '#0082C9';

export const LANGS = [
    { code: 'nl', label: 'Dutch' }, { code: 'en', label: 'English' }, { code: 'de', label: 'German' },
    { code: 'fr', label: 'French' }, { code: 'es', label: 'Spanish' }, { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' },
];

/**
 * On/off switch. Pass the row title as `ariaLabel`: the switch has no visible
 * text of its own.
 *
 * @param {{ on?: boolean, onClick?: () => void, disabled?: boolean, ariaLabel?: string }} props
 */
export const Toggle = ({ on, onClick, disabled, ariaLabel }) => (
    <button
        type="button" onClick={onClick} disabled={disabled} aria-pressed={!!on} aria-label={ariaLabel}
        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 disabled:opacity-60 ${on ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'}`}
    >
        {/* The knob takes the accent's readable foreground when on: white on a
            very light accent (high-contrast, obsidian) would vanish. */}
        <div className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full shadow transition-transform ${on ? 'translate-x-5 bg-[var(--accent-primary-fg)]' : 'bg-white'}`} />
    </button>
);

/** A settings row: title and description, the control beside them (below them on a phone). */
export const Row = ({ title, desc, children }) => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5 bg-[var(--bg-secondary)]">
        <div className="flex-1 min-w-0">
            <p className="text-[13px] font-medium text-[var(--text-primary)]">{title}</p>
            <p className="text-[11px] text-[var(--text-muted)]">{desc}</p>
        </div>
        {children}
    </div>
);

/**
 * @param {{ value?: string, onChange?: (e: any) => void, disabled?: boolean,
 *           options: Array<{ value: string, label: string }>, ariaLabel?: string }} props
 */
export const Select = ({ value, onChange, disabled, options, ariaLabel }) => (
    <select
        value={value} onChange={onChange} disabled={disabled} aria-label={ariaLabel}
        className="w-40 px-3 py-1.5 rounded-lg border outline-none text-[13px] bg-[var(--bg-primary)] border-[var(--border-default)] text-[var(--text-primary)]"
    >
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
);
