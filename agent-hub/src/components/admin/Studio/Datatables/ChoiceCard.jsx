import React from 'react';
import { kindColorVar, kindIcon } from '../../../shared/kindColors';

/**
 * One of a few side-by-side answers (Datatables artboard 1c): a real radio,
 * an ink border when chosen, the kind's own glyph — or a ready icon — a title
 * and one sentence.
 *
 * Its own file because two dialogs use it (the create dialog and the
 * Nextcloud link wizard), and a card copied into a second file is a card
 * whose selected border drifts by a pixel.
 *
 * `disabled` keeps the card VISIBLE with a `note` saying why — for the answer
 * a person can see but cannot pick right now (a Nextcloud table when the
 * Tables integration is off). Hiding it would leave them looking for a
 * feature the product has; greying it out with the reason tells them what to
 * switch on.
 */
export default function ChoiceCard({ name, kind, icon, checked, onChange, title, blurb, disabled = false, note = null }) {
    const Glyph = kind ? kindIcon(kind) : null;
    return (
        <label
            className={`flex flex-col gap-1.5 p-3 min-w-0 focus-within:outline focus-within:outline-2 focus-within:outline-offset-1 ${disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
            aria-disabled={disabled || undefined}
            style={{
                borderRadius: 12,
                background: 'var(--bg-primary)',
                // 1px border + a 1px inset ring reads as the artboard's 2px
                // selected border without moving the card by a pixel.
                border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border-default)'}`,
                boxShadow: checked ? 'inset 0 0 0 1px var(--accent-primary)' : 'none',
                outlineColor: 'var(--accent-primary)',
                opacity: disabled ? 0.6 : 1,
            }}
        >
            <span className="flex items-center gap-2 min-w-0">
                <input type="radio" name={name} checked={checked} onChange={onChange} disabled={disabled} className="shrink-0" />
                {icon}
                {Glyph && !icon && <Glyph className="w-3.5 h-3.5 shrink-0" style={{ color: kindColorVar(kind) }} aria-hidden="true" />}
                <span className="text-sm font-semibold min-w-0" style={{ color: 'var(--text-primary)' }}>{title}</span>
            </span>
            <span className="text-[11px] leading-[17px]" style={{ color: 'var(--text-secondary)' }}>{blurb}</span>
            {note && (
                <span className="text-[11px] leading-[17px]" style={{ color: 'var(--text-tertiary)' }}>{note}</span>
            )}
        </label>
    );
}
