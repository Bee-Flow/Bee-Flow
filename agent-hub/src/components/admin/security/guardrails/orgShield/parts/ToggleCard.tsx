import React, { useId } from 'react';

import Toggle from '../../../../../shared/Toggle';

/**
 * One setting row inside a shared card: title, description, switch — plus
 * optional controls revealed underneath (the last check's mode picker).
 *
 * Replaces seven hand-rolled copies of the same markup. Each of those wrapped
 * a `<label>` around ONLY the switch track, with the title and description as
 * siblings — so the checkbox had no accessible name at all (a screen reader
 * announced seven anonymous checkboxes) and clicking the title did nothing.
 *
 * It builds its own markup rather than delegating to Toggle's row mode, for
 * two reasons:
 *
 *   1. Toggle's row wraps the WHOLE row in one `<label htmlFor>`, so a link
 *      inside a description would flip the switch when clicked, and nesting an
 *      interactive element inside a label is invalid HTML. Here only the title
 *      is the label.
 *   2. Toggle's row truncates its title. These titles run to ~60 characters in
 *      Dutch, and a truncated setting name is not a setting name.
 *
 * Rows draw a hairline above themselves except the first in their container,
 * so a card can stack them under its header without a double border.
 */

export type RowIcon = React.ComponentType<{ className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>;

/** The row frame, shared with rows that have no switch (a licence-locked one). */
export const ROW_CLASS = 'grid gap-x-4 gap-y-3 items-start px-[18px] py-3.5 border-t border-[var(--border-subtle)] first:border-t-0';
export const ROW_COLS = {
    plain: 'grid-cols-[minmax(0,1fr)_auto]',
    icon: 'grid-cols-[18px_minmax(0,1fr)_auto]',
};
export const ROW_TITLE = 'block m-0 text-[13px] font-semibold leading-[18px] text-[var(--text-primary)]';
export const ROW_DESC = 'm-0 text-xs leading-[17px] text-[var(--text-secondary)]';

export interface ToggleCardProps {
    Icon?: RowIcon;
    /** A plain string: it is also the switch's accessible name. */
    title: string;
    description?: React.ReactNode;
    /** A consequence worth a second look, in warning ink under the description. */
    note?: React.ReactNode;
    checked: boolean;
    onChange: (next: boolean) => void;
    disabled?: boolean;
    /** Revealed controls, drawn across the full width of the row. */
    children?: React.ReactNode;
}

export function ToggleCard({
    Icon, title, description, note, checked, onChange, disabled = false, children,
}: ToggleCardProps) {
    const id = useId();
    return (
        <div className={`${ROW_CLASS} ${Icon ? ROW_COLS.icon : ROW_COLS.plain} ${disabled ? 'opacity-60' : ''}`}>
            {Icon && <Icon className="w-4 h-4 shrink-0 mt-px text-[var(--text-secondary)]" aria-hidden="true" />}
            <div className="min-w-0">
                <label htmlFor={id} className={`${ROW_TITLE} cursor-pointer`}>{title}</label>
                {description != null && <p className={ROW_DESC}>{description}</p>}
                {note != null && <p className="m-0 mt-1 text-xs leading-[17px] text-[var(--warning-ink)]">{note}</p>}
            </div>
            <Toggle
                id={id}
                checked={checked}
                onChange={onChange}
                disabled={disabled}
                size="md"
                ariaLabel={title}
            />
            {children != null && children !== false && <div className="col-span-full min-w-0">{children}</div>}
        </div>
    );
}

export default ToggleCard;
