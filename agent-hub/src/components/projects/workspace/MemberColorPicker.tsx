// The colour dot of a person in the members list: click it to choose one of
// the project's colours for them (or "Automatic"). Shown as a plain dot to
// people who may not change it.

import { Check } from 'lucide-react';
import React, { useRef, useState, type ComponentType } from 'react';
import { useTranslation } from '../../../hooks/useTranslation';
import AnchoredMenuJs from '../../shared/AnchoredMenu';
import { MEMBER_COLORS } from './memberColors';

// The menu is untyped JavaScript: props are passed by name, as the other users of it do.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export interface MemberColorPickerProps {
    name: string;
    /** The colour the person is shown in (theirs, or the automatic one). */
    color: string;
    /** The colour the project gave them; absent when they are on the automatic one. */
    chosen?: string;
    /** Whether the reader may change it (the owner for anyone, a person for themselves). */
    canChange: boolean;
    busy?: boolean;
    onChange: (color: string | null) => void;
}

export default function MemberColorPicker({ name, color, chosen, canChange, busy = false, onChange }: MemberColorPickerProps) {
    const { t } = useTranslation();
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const dot = <span className="block w-3.5 h-3.5 rounded-full" style={{ background: color }} aria-hidden="true" />;
    if (!canChange) {
        return <span className="grid place-items-center w-7 h-7" title={t('project_home.members.colour_of', 'Colour of {name}', { name })} data-testid="member-colour-static">{dot}</span>;
    }
    const pick = (next: string | null) => { setOpen(false); onChange(next); };
    return (
        <>
            <button ref={anchor} type="button" onClick={() => setOpen(o => !o)} disabled={busy} aria-haspopup="menu" aria-expanded={open}
                aria-label={t('project_home.members.colour_for', 'Colour for {name}', { name })} title={t('project_home.members.colour_for', 'Colour for {name}', { name })}
                data-testid="member-colour-button"
                className="grid place-items-center w-7 h-7 rounded-md hover:bg-[var(--item-hover-bg)] disabled:opacity-50">
                {dot}
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="right" width={196} role="menu"
                aria-label={t('project_home.members.colour_for', 'Colour for {name}', { name })} className="p-2">
                <div className="grid grid-cols-5 gap-1.5" role="group">
                    {MEMBER_COLORS.map(c => (
                        <button key={c.hex} type="button" role="menuitemradio" aria-checked={chosen === c.hex} onClick={() => pick(c.hex)}
                            aria-label={t(c.labelKey, c.label)} title={t(c.labelKey, c.label)} data-testid={`member-colour-${c.hex.slice(1)}`}
                            className="grid place-items-center w-8 h-8 rounded-full border-2 border-transparent hover:border-[var(--border-default)]"
                            style={{ background: c.hex }}>
                            {chosen === c.hex && <Check className="w-4 h-4 text-white" aria-hidden="true" />}
                        </button>
                    ))}
                </div>
                <button type="button" role="menuitem" onClick={() => pick(null)} disabled={!chosen} data-testid="member-colour-auto"
                    className="mt-2 w-full text-left px-2 py-1.5 rounded-md text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--item-hover-bg)] disabled:opacity-50">
                    {t('project_home.members.colour_auto', 'Automatic')}
                </button>
            </AnchoredMenu>
        </>
    );
}
